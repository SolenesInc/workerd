# ghcr.io/solenesinc/oven-workerd: the image an oven Worker service's image is built FROM.
# Debian bookworm's glibc (2.36) with CA certificates and no shell. The build context is a
# directory holding the release binary, named workerd.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f
COPY workerd /usr/local/bin/workerd
USER 1000:1000
ENTRYPOINT ["workerd"]
