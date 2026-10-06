# AI Document Intelligence Platform — Frontend

React 19 single-page application for the AI Document Intelligence Platform:
document management, semantic search, LLM question answering, dashboards,
admin tooling, and webhook management.

## Stack

- **React 19** + **TypeScript** (strict)
- **Vite 8** for dev server and production build
- **react-router-dom** for routing (lazy-loaded routes)
- **Vitest** + Testing Library for tests
- **oxlint** / **oxfmt** for linting and formatting

## Quick start

```bash
cd frontend
npm install
npm run dev        # dev server on :5173 (proxies /v1 to the backend)
```

The app is served at `http://localhost:5173` and proxies `/v1/*` to the
backend at `http://localhost:8000` by default (override with
`VITE_PROXY_TARGET`). For the full dev sandbox, see the repo root
`DEVELOPMENT.md`.

## Pages

| Route                  | Page      | Description                                         |
| ---------------------- | --------- | --------------------------------------------------- |
| `/`                    | Landing   | Marketing page with features, pricing, demo CTA     |
| `/login` / `/register` | Auth      | Login / registration                                |
| `/demo`                | Demo      | Public interactive demo (client-side only)          |
| `/app`                 | Dashboard | Personal stats + recent documents                   |
| `/app/documents`       | Documents | Upload (single/bulk), manage, thumbnail previews    |
| `/app/search`          | Search    | Semantic search with pagination + CSV/JSON export   |
| `/app/qa`              | Q&A       | Chat-style question answering with source citations |
| `/app/settings`        | Settings  | QA model selection + bring-your-own-key             |
| `/app/profile`         | Profile   | Update username/password                            |
| `/app/admin`           | Admin     | User management + system statistics (admin only)    |
| `/app/webhooks`        | Webhooks  | Subscribe to document-processing events             |

All `/app/*` routes are guarded by `ProtectedRoute` and require auth.

## Scripts

```bash
npm run dev          # dev server (HMR)
npm run build        # typecheck (tsc -b) + production build
npm run lint         # oxlint
npm run lint:fix     # auto-fix lint issues
npm run format       # oxfmt
npm run test         # vitest run
npm run test:watch   # vitest watch
npm run preview      # preview the production build
```

## Testing

Tests are colocated with source files as `*.test.ts(x)` and run with Vitest
against jsdom. API calls are mocked with `vi.mock()`; components are tested
with `@testing-library/react`.

```bash
npm test                 # run all tests once
npm run test:coverage    # run with coverage report
```

## Layout

```
frontend/
├── src/
│   ├── components/      # Navbar, DocumentFilter, Markdown, Skeleton, ...
│   ├── context/         # ToastContext (notifications)
│   ├── hooks/           # useAuth (JWT lifecycle), useTheme
│   ├── pages/           # one folder per route
│   ├── services/        # typed API client (api.ts)
│   ├── types/           # shared TypeScript types
│   ├── App.tsx          # routing + LandingGate
│   └── main.tsx         # entry point
├── nginx.conf           # production SPA config (+ /v1 proxy)
├── vite.config.ts       # dev server + proxy
└── package.json
```

See the repo root `README.md` / `PROJECT_CONTEXT.md` for the full platform
overview and `AGENTS.md` for development workflow.
