# Build from the repository root: docker build -f backend/gateway/Dockerfile .
FROM golang:1.26-alpine AS builder
WORKDIR /build
COPY backend/gateway/go.mod backend/gateway/go.sum ./
RUN go mod download
COPY backend/gateway ./
RUN CGO_ENABLED=0 go build -o /api-go ./cmd/api

FROM alpine:3.23
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 tallythis
WORKDIR /app
COPY --from=builder /api-go ./api-go
ENV PORT=8090
USER tallythis
EXPOSE 8090
CMD ["./api-go"]
