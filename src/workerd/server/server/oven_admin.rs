// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

//! Oven's admin socket (`--oven-admin-addr`). It has one endpoint:
//!
//! ```text
//! POST /objects/<class>/<id>/sql  {"query": "..."}  -> 200 {"rows": [...]}
//! ```
//!
//! The statement runs inside the live Durable Object `<id>` (its 64-hex id) of class `<class>`,
//! on the object's own connection, as `ctx.storage.sql.exec()` runs it: the object sees the write,
//! the SQL API's restrictions apply, and nothing but this process writes the object's file. The
//! answer comes once the write is durable.
//!
//! A write never creates an object: an object with no file, like an unknown class, is a 404. A
//! bad request or a statement that is refused is a 400. Every error body is `{"error": "..."}`.
//! The socket has no authentication; oven admits only its data pod to it.

use std::pin::Pin;
use std::rc::Rc;

use kj::http::Headers;
use kj::http::HeadersRef;
use kj::http::Method;
use kj::http::ServiceResponse;
use kj_hyper::server::Connect;
use kj_hyper::server::Handler;
use serde::Deserialize;
use serde_json::json;

use crate::Result;
use crate::bridge::ffi;
use crate::config::Server;
use crate::services::header_table;

/// The largest request body, a tripwire: a statement typed into `oven sql` is bytes to a few
/// KiB, and the body is JSON around one.
const MAX_BODY: usize = 1 << 20;

pub struct AdminConnection {
    pub server: Rc<Server>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SqlRequest {
    query: String,
}

/// An answer: a status and its JSON body.
struct Reply(u32, serde_json::Value);

fn error(status: u32, message: impl Into<String>) -> Reply {
    Reply(status, json!({ "error": message.into() }))
}

impl AdminConnection {
    async fn answer(
        &self,
        method: Method,
        url: &[u8],
        body: Pin<&mut kj::io::AsyncInputStream>,
    ) -> Reply {
        let path = String::from_utf8_lossy(url);
        let path = path.split('?').next().unwrap_or_default();
        let ["", "objects", class, id, "sql"] = path.split('/').collect::<Vec<_>>()[..] else {
            return error(404, format!("no such endpoint: {path}"));
        };
        if method != Method::POST {
            return error(405, format!("{path} takes POST"));
        }
        let query = match read_body(body).await {
            Ok(bytes) => match serde_json::from_slice::<SqlRequest>(&bytes) {
                Ok(request) => request.query,
                Err(e) => {
                    return error(400, format!("the body must be {{\"query\": \"...\"}}: {e}"));
                }
            },
            Err(reply) => return reply,
        };
        let namespaces: Vec<_> = self
            .server
            .services()
            .filter_map(|(_, service)| service.as_worker())
            .flat_map(|worker| worker.namespaces())
            .filter(|(_, namespace)| namespace.unique_key().is_some())
            .collect();
        let Some((_, namespace)) = namespaces.iter().find(|(name, _)| name == class) else {
            let known: Vec<_> = namespaces.iter().map(|(name, _)| name.as_str()).collect();
            return error(
                404,
                format!(
                    "no Durable Object class {class}; the classes are: {}",
                    known.join(", ")
                ),
            );
        };
        let worker = match namespace.existing_object(id) {
            Ok(Some(worker)) => worker,
            Ok(None) => return error(404, format!("{class} has no object {id}")),
            Err(e) => return error(500, e.description()),
        };
        match ffi::actor_oven_sql(worker, &query).await {
            Ok(rows) => match serde_json::from_str::<serde_json::Value>(&rows) {
                Ok(rows) => Reply(200, json!({ "rows": rows })),
                Err(e) => error(500, format!("the rows are not JSON: {e}")),
            },
            Err(e) => {
                // The statement's own failure is a JavaScript error, as the application would see
                // it: `jsg.Error: <message>`, possibly after context the runtime adds.
                let description = e.to_string();
                match description.find("jsg.").map(|at| &description[at..]) {
                    Some(refused) => {
                        error(400, refused.split_once(": ").map_or(refused, |(_, m)| m))
                    }
                    None => error(500, description),
                }
            }
        }
    }
}

/// The request body, up to [`MAX_BODY`].
async fn read_body(
    mut body: Pin<&mut kj::io::AsyncInputStream>,
) -> std::result::Result<Vec<u8>, Reply> {
    let mut bytes = Vec::new();
    let mut buffer = vec![0; 64 * 1024];
    loop {
        let n = body
            .as_mut()
            .try_read(&mut buffer, 1)
            .await
            .map_err(|e| error(400, format!("reading the body: {}", e.description())))?;
        if n == 0 {
            return Ok(bytes);
        }
        bytes.extend_from_slice(&buffer[..n]);
        if bytes.len() > MAX_BODY {
            return Err(error(
                413,
                format!("the body is over the admin socket's limit of {MAX_BODY} bytes"),
            ));
        }
    }
}

#[async_trait::async_trait(?Send)]
impl Handler for AdminConnection {
    async fn request<'a>(
        &'a self,
        method: Method,
        url: &'a [u8],
        _headers: HeadersRef<'a>,
        body: Pin<&'a mut kj::io::AsyncInputStream>,
        response: ServiceResponse<'a>,
    ) -> Result<()> {
        let Reply(status, value) = self.answer(method, url, body).await;
        let text = match status {
            200 => "OK",
            400 => "Bad Request",
            404 => "Not Found",
            405 => "Method Not Allowed",
            413 => "Content Too Large",
            _ => "Internal Server Error",
        };
        let bytes = value.to_string();
        let table = header_table(&self.server.factory());
        let headers = Headers::new(table);
        let mut out = response.send(status, text, &headers, Some(bytes.len() as u64))?;
        out.write(bytes.as_bytes()).await
    }

    async fn connect<'a>(
        &'a self,
        _host: &'a [u8],
        _headers: HeadersRef<'a>,
        connect: Connect,
    ) -> Result<()> {
        let table = header_table(&self.server.factory());
        let empty = Headers::new(table);
        connect.reject(405, "Method Not Allowed", HeadersRef::from(&empty), Some(0))?;
        Ok(())
    }
}
