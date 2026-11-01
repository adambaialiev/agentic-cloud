# agentbuilt.app apex redirect

`https://agentbuilt.app/<anything>` answers `301` to
`https://agenticcloudcomputer.com/<anything>` (path and query kept). Note #683.

The whole site is `public/_redirects`, served by the Cloudflare Pages project
`agentbuilt-app-redirect` (account `2acc98ccfb2a55a86ba0314e7955f657`).
`agentbuilt.app` is attached to it as a Pages custom domain, and the zone has a
proxied (orange-cloud) apex record `CNAME agentbuilt.app -> agentbuilt-app-redirect.pages.dev`.

Only the apex. Every subdomain still goes where it did: machine previews through
the `*.agentbuilt.app/*` Worker (`infra/preview-router`), hosted sites through
their own grey-cloud records. A Worker route of `*.agentbuilt.app/*` does not
match the bare apex, so the two never meet.

## Deploy (manual, like the preview router)

    cd infra/apex-redirect
    CLOUDFLARE_API_TOKEN=$CLOUDFLARE_PAGES_TOKEN CLOUDFLARE_ACCOUNT_ID=2acc98ccfb2a55a86ba0314e7955f657 \
      npx --yes wrangler@3 pages deploy public --project-name=agentbuilt-app-redirect --branch=main

Pin `wrangler@3`: wrangler 4 hands `pages` commands to Workers and fails with
"Missing entry-point" on a folder that only holds `_redirects`.

## Rebuilding from nothing

1. `wrangler@3 pages project create agentbuilt-app-redirect --production-branch main`, then deploy as above.
2. Attach the domain with the Pages token:
   `POST /accounts/<account>/pages/projects/agentbuilt-app-redirect/domains {"name":"agentbuilt.app"}`.
3. Create the apex record with the zone's DNS token (`CLOUDFLARE_APPS_DNS_TOKEN` in
   `/etc/infinite-agents/backend.env` on the backend host — the Pages token cannot write DNS):
   `POST /zones/<zone>/dns_records {"type":"CNAME","name":"agentbuilt.app","content":"agentbuilt-app-redirect.pages.dev","proxied":true}`.
4. The domain turns `active` within a couple of minutes; `curl -sI https://agentbuilt.app/` shows the 301.
