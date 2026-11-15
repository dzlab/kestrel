# Kestrel UI development

The API server chooses an available loopback port. Start it first, then pass the
printed origin to Vite so the same-origin `/api` proxy targets that exact process:

```sh
KESTREL_API_ORIGIN=http://127.0.0.1:49152 npm run ui:dev
```

Replace the example origin with the exact URL printed by the API server.

`KESTREL_API_ORIGIN` is required only for the development server. Production
`ui:build` output uses same-origin API paths and does not require the variable.
