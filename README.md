# Gosh Cold Store

The system follows four development phases: Phase 1 Foundation & Inventory; Phase 2 Sales, Cash Tally & Finance; Phase 3 Reports, Profit/Loss & Business Intelligence; Phase 4 Receipt & Printing. The client is React, TypeScript and Vite; the API is Express; PostgreSQL holds the shared operational data and receipt snapshots.

The shared Phase 1–4 relational design, relationship diagram, cost rules, report sources, and receipt snapshots are documented in [docs/DATA_MODEL.md](docs/DATA_MODEL.md). The phases remain Foundation & Inventory; Daily Operations; Management & Reporting; and Receipt & Printing.

## Requirements

- Node.js 20.19+ or 22.12+
- PostgreSQL 15+

## Local setup

1. Install dependencies with `npm install`.
2. On this Windows workspace, PostgreSQL 18 is listening on `127.0.0.1:5434` (PostgreSQL 13 is on `5433`, PostgreSQL 17 is on `5435`). Create a database named `essumans_cold_store` using pgAdmin, or run `& "C:\Program Files\PostgreSQL\18\bin\psql.exe" -h 127.0.0.1 -p 5434 -U postgres -d postgres -c "CREATE DATABASE essumans_cold_store;"` in PowerShell. `psql` will prompt for the PostgreSQL password locally.
3. Copy `.env.example` to `.env`; replace the database password placeholder with your local PostgreSQL password, set a unique random `JWT_SECRET`, and choose a strong `ADMIN_PASSWORD` (at least 10 characters). Do not send these secrets in chat.
4. Initialize the schema and first administrator with `npm run db:init`.
5. Start the API in one terminal with `npm run dev:api`.
6. Start Vite in another terminal with `npm run dev`, then open the local URL it prints. The interface also has a clearly labeled sample preview when the API is not configured.

The initial administrator can also be created once through `POST /api/auth/bootstrap`; this route refuses to create another account after any user exists. Prefer the environment-based bootstrap for local deployment.

## Phase 1 API

All authenticated routes use `Authorization: Bearer <token>`. Login and initial bootstrap return a token.

- `POST /api/auth/login`, `GET /api/auth/me`, `PATCH /api/auth/password`
- `GET /api/users`, `POST /api/users`, `PATCH /api/users/:id/active` (admin only)
- `GET /api/products`, `POST /api/products`, `PATCH /api/products/:id` (product writes admin only)
- `POST /api/stock/receive`, `POST /api/stock/adjustments`
- `GET /api/stock/low`, `GET /api/stock/history`
- `GET /api/dashboard`, `GET /api/health`
- `POST /api/sales`, `GET /api/sales`, `GET /api/sales/:id/receipt`
- `POST /api/sales/:id/reverse` (admin only; restores stock and retains the receipt)
- `POST /api/income`, `POST /api/expenses`, `GET /api/finance/transactions`
- `GET /api/finance/daily`, `POST /api/finance/close`, `GET /api/finance/closures` (admin only)
- `PATCH /api/finance/:type/:id`, `POST /api/finance/:type/:id/void` (admin only, audited)
- `GET /api/stock/adjustment-requests`, `PATCH /api/stock/adjustment-requests/:id` (admin approval)
- `GET /api/audit` (admin only)
- `GET /api/business-profile`, `PATCH /api/business-profile` (receipt branding write is admin only)
- `GET /api/receipts?q=&from=&to=`, `GET /api/receipts/:id`

Attendants can search/reprint their own receipts; admins can search/reprint all receipts. Each receipt uses the saved sale and item snapshots, not current product prices. Business name, contact details, logo URL, footer and QR option are managed from the receipt archive page.

Receipts, adjustments, sale completion, sale reversal, daily close, and approval actions use PostgreSQL transactions. Sale lines snapshot selling price and cost price; each sale records margin and creates stock movement records. Negative stock is rejected. Attendant stock adjustments are queued for admin approval. Passwords use bcrypt hashes and API tokens expire after eight hours.

## Role boundaries

Admins can manage users, edit product details, access inactive products, view all transactions and closeouts, correct or void income/expense entries with an audit reason, reverse sales, and approve/reject attendant stock adjustments. Attendants can sell active products, record deliveries, log income/expenses, submit stock adjustments, view their own sales and close their own business day. Closing blocks additional same-day sales and entries for that user. The API enforces these rules independently of the UI.

## Current Phase 2 boundaries

With an API session, the dashboard loads persisted products, stock history and inventory metrics. Product create/edit/status, stock receipt/adjustment, user administration and password changes are API-backed. The sample preview uses representative browser-only data and is visibly labeled; its changes are not persisted.

Sales totals, gross margin, other income, expenses, expected cash, and attendant/admin cash differences are now calculated from persisted transactions. Phase 4 provides unique receipt numbers, a searchable archive, business branding, reprint, 58mm/80mm/A4 print layouts, PDF download, optional QR codes, discount/tender/change snapshots. Formal Phase 3 report endpoints and exports, refunds that retain returned-goods detail, multi-register shifts, and split tender remain future work.

The database foundation also includes normalized supplier purchases, product category/unit dimensions, a configured business timezone/fiscal-year start, report views, and a general audit timeline. Phase 3 report endpoints, selection UI, BI visualizations, and PDF/Excel/CSV report generation remain to be implemented against these shared facts/views.

This starter does not yet include deployment hardening, refresh tokens, password reset email, rate limiting, or automated API tests. Keep `.env` private and use a managed secret store in deployment.