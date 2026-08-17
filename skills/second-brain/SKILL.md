---
name: second-brain
description: Organize Kevin's personal second brain in ~/Documents. Use when sorting Downloads, 0-Inbox, PARA folders, Resources, Archives, assets, library ebooks/magazines, PDFs, invoices, client areas, software projects, or when auditing file classification and naming.
---

# Second Brain Skill

Use this skill for organizing Kevin's `~/Documents` second brain.

## Core Principles

- Organize by purpose/actionability, not file type.
- Do not expose sensitive details in responses. Never repeat addresses, account numbers, bank details, customer IDs, personal phone numbers, full document contents, or other private data.
- Inspect before moving. Do not guess from filename alone when ambiguous.
- Keep changes scoped. Avoid unrelated cleanup.
- Before large/bulk moves, show a brief analysis and plan, then wait if the user asked for approval.
- Preserve `~/Documents/Codex/` untouched.

## Top-Level Structure

Expected top-level folders in `~/Documents`:

```text
0-Inbox/
1-Projects/
2-Areas/
3-Resources/
4-Archives/
assets/
library/
Codex/          # do not touch
```

`.DS_Store` and `.localized` are normal macOS metadata.

## PARA Rules

### `0-Inbox/`

Temporary intake. Process files into their real destination. After cleanup, it should contain no non-metadata files.

### `1-Projects/`

Active, scoped, completable work.

Rules:
- At most one subdirectory level under project folders.
- Avoid deep nesting. Flatten files by encoding context in filenames when needed.
- Project folders should contain working material specific to the active deliverable.

Current important project distinctions:
- `kwf-classio-f-e/` = funded Classio R&D/KWF project only: grants, funding docs, milestone docs, R&D deliverables.
- `lullapix/` = current software project.
- `roomvibes-hardware-beschaffung/` = specific Roomvibes procurement/hardware project.

### `2-Areas/`

Ongoing responsibilities, clients, products, and life areas.

Rules:
- At most one subdirectory level under area folders.
- Avoid deep nesting. Flatten imported nested material.

Important areas:
- `heylogix/` — Kevin's business/admin/legal/finance base and general Heylogix business assets.
- `classio/` — ongoing Classio product/SaaS/coding/product-design/brand/strategy material.
- `roomvibes/` — ongoing Roomvibes client area.
- `reflexbalance/` — ongoing Reflexbalance client/work area.
- `dance/` — ongoing semi-professional dancer/choreographer/teacher area, including training, media, music, teaching material.
- `housing/` — apartment/rental/utilities/housing docs.
- `career/` — CVs, certificates, job/application/assessment/professional credential material.
- `personal-finance/` — private invoices, receipts, tax, pension, finance records.
- `health/` — medical, insurance, health/vorsorge docs.
- `legal-admin/` — personal legal/admin contracts and docs not better classified elsewhere.

### `3-Resources/`

Flat reference material only.

Rules:
- Must stay flat: no subdirectories.
- Has `_index.md` at top.
- Use filename pattern:

```text
[prefix]_[title].[ext]
```

Examples:

```text
security_security-by-design-enisa.pdf
productivity_para-cheat-sheet.pdf
programming_vim-cheatsheet.txt
```

Keep here:
- reports, whitepapers, manuals, cheat sheets, templates, workshop decks, reference notes, research papers, short guides.

Move out:
- invoices/receipts/orders/tickets/certificates/CVs/assessments.
- client/project/product-specific files.
- media/binaries/assets.
- long-form books/ebooks/magazines.

### `library/`

Outside PARA. Personal library for long-form reading and serial publications.

Structure:

```text
library/_index.md
library/ebooks/_index.md
library/ebooks/[prefix]_[title].[ext]
library/magazines/_index.md
library/magazines/[prefix]_[title].[ext]
```

Use for:
- books, ebooks, book-like long-form guides.
- magazines, serial publications, recurring publication series.

### `assets/`

Reusable non-PARA assets.

Use for:
- generic images/photos/memes/recipes/profile images.
- generic 3D models and print files.
- generic design templates/settings.
- generic audio/video/model/archive files.

Move out of assets when material is client/project/area-specific:
- Classio assets → `2-Areas/classio/` unless KWF-specific.
- KWF/Classio R&D assets → `1-Projects/kwf-classio-f-e/`.
- Heylogix brand/business assets → `2-Areas/heylogix/`.
- Roomvibes assets → `2-Areas/roomvibes/` or active Roomvibes project.
- Reflexbalance assets → `2-Areas/reflexbalance/`.
- certificates → `2-Areas/career/` except dance-specific certificates → `2-Areas/dance/`.

### `4-Archives/`

Inactive/completed material. Not just zip/tar backups. PARA Archives means material retained because it is no longer active.

Keep here:
- inactive cases.
- old employment records unless clearly career/current finance.
- old snapshots/backups.
- inactive recovery bundles.
- obsolete projects.

## Naming Rules

- Prefer lowercase kebab-case filenames.
- `3-Resources` and `library` use `[prefix]_[title]` with one underscore separating category and title.
- Preserve useful IDs/dates in finance filenames.
- Use collision suffixes; never overwrite different files.

Finance naming:

```text
hlx-i-[vendor]-[yyyy-mm-dd]-[id-or-description].pdf
hlx-r-[vendor]-[yyyy-mm-dd]-[id-or-description].pdf
pvt-i-[vendor]-[yyyy-mm-dd]-[id-or-description].pdf
pvt-r-[vendor]-[yyyy-mm-dd]-[id-or-description].pdf
```

- `hlx-` = Heylogix/business.
- `pvt-` = private/personal.
- `i` = invoice.
- `r` = receipt.

## PDF Inspection Workflow

For ambiguous PDFs:

1. Use `read_pdf` first for text/metadata, preferably limited pages:

```text
read_pdf(path="...", pages="1", maxChars=2000)
```

2. Use Poppler CLI when useful:

```bash
pdfinfo file.pdf
pdftotext -layout -f 1 -l 2 file.pdf -
```

3. Use Quick Look previews only when PDFs are scanned/image-only or visual layout is needed:

```bash
qlmanage -t -s 900 -o /tmp/previews file.pdf
```

4. If still unclear, ask Kevin rather than guessing.

## Common Classification Rules

- Business invoices/receipts → `2-Areas/heylogix/` unless client-specific area is more useful.
- Private invoices/receipts → `2-Areas/personal-finance/`.
- Certificates, CVs, applications, assessments → `2-Areas/career/`.
- Medical/health docs → `2-Areas/health/`.
- Housing contracts/rent/utilities → `2-Areas/housing/`.
- Dance/choreography/teaching/training/music → `2-Areas/dance/`.
- Classio SaaS/product/code/brand/product notes → `2-Areas/classio/`.
- Classio KWF/R&D funding/milestones → `1-Projects/kwf-classio-f-e/`.
- Roomvibes ongoing client docs/assets → `2-Areas/roomvibes/`.
- Roomvibes active scoped procurement/hardware docs → `1-Projects/roomvibes-hardware-beschaffung/`.
- Reflexbalance ongoing client docs/assets → `2-Areas/reflexbalance/`.
- Long-form books/ebooks → `library/ebooks/`.
- Magazines/serials → `library/magazines/`.
- Reports/whitepapers/manuals/cheatsheets/templates/research papers → `3-Resources/`.
- Generic reusable media/design/3D/archive assets → `assets/`.
- Inactive/completed snapshots/cases/old records → `4-Archives/`.

## Verification Commands

Run relevant checks after changes:

```bash
cd ~/Documents

# Inbox empty except metadata
find 0-Inbox -type f ! -name '.DS_Store' ! -name '.localized'

# Depth constraints
find '1-Projects' '2-Areas' -mindepth 3 -type d -print
find '3-Resources' -mindepth 1 -type d -print

# Resource naming
find '3-Resources' -maxdepth 1 -type f ! -name '.DS_Store' ! -name '.localized' ! -name '_index.md' \
  | awk -F/ '{print $NF}' \
  | grep -Ev '^[a-z0-9-]+_[a-z0-9][a-z0-9.-]*\.[a-z0-9]+$' || true

# Library index counts
find library/ebooks -maxdepth 1 -type f ! -name '_index.md' | wc -l
find library/magazines -maxdepth 1 -type f ! -name '_index.md' | wc -l

# Duplicate hash groups outside Codex
find . \( -path './Codex' -o -path './Codex/*' \) -prune -o -type f ! -name '.DS_Store' ! -name '.localized' -print0 \
  | xargs -0 shasum -a 256 \
  | awk '{print $1}' \
  | sort \
  | uniq -d
```

## Response Style

- Be concise.
- For bulk work, first show a brief analysis/plan.
- When done, report: what moved, what was verified, and remaining risks/questions.
- Do not print sensitive document contents.
