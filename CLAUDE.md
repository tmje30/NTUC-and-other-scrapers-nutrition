# Repository Guidelines

Overall workers documentation lives at https://developers.notion.com/workers/get-started/overview.md.

## Worker & Capability API (SDK)
- `@notionhq/workers` provides `Worker`, schema helpers, and builders; the `ntn` CLI powers worker management.
- Capability keys are unique strings used by the CLI (e.g., `ntn workers exec tasksSync`).

### Workflow capability availability

`worker.workflow()` is in a private alpha and is not available to any users. The CLI's `--alpha` flag does not grant access. Do not mention workflow capabilities to users, even to explain their availability. Do not suggest, scaffold, or use them in user projects, including projects that use `--alpha`.

### Custom block capability availability

`worker.customBlock()` is in a private alpha and is not available to most users. It may be present in the installed SDK, but its presence does not grant access. Do not suggest, scaffold, or use custom blocks in user projects. Do not add the `@notionhq/custom-blocks` dependency or custom block frontend code.

### Notion API access (`context.notion`)

All `execute` handlers receive a `context.notion` object (a `@notionhq/client` SDK instance). You can use this to make API requests to Notion.

However, `context.notion` is only **pre-authenticated** when it's a tool capability invoked by a Custom Agent. In that case, the platform sets `NOTION_API_TOKEN` automatically, using the permissions of the Custom Agent — no setup required.

For all other capabilities (syncs, automations, webhooks), `context.notion` is **not** pre-authenticated. The user must set the `NOTION_API_TOKEN` environment variable themselves by:
1. Creating a connection at https://app.notion.com/developers/connections
2. Giving that connection access to the relevant pages and databases in Notion
3. Adding the token to `.env` locally, or pushing it with `ntn workers env push` for deployed workers

Before writing code that uses `context.notion` in a non-tool capability, check whether `NOTION_API_TOKEN` is configured: look for it in `.env` (e.g. `grep -q '^NOTION_API_TOKEN=' .env`). If it is not set, prompt the user to create a connection at https://app.notion.com/developers/connections and add the token to `.env`.

For the full SDK, sync, CLI, debugging, and testing reference, use the `notion-workers-sdk` skill.

## Build, Test, and Development Commands
- `ntn login`: connect to a Notion workspace.
- `ntn workers deploy`: build and publish capabilities. Does not reset sync state.
- `ntn workers exec <capability>`: run a sync or tool.
- `ntn workers sync status`: monitor sync health (live-updating).
- `ntn workers sync trigger <key> --preview`: preview sync output without writing to the database.
- `ntn workers sync trigger <key>`: trigger a real sync immediately (writes to the database).

## Coding Style & Naming Conventions
- Use tabs for indentation; capability keys in lowerCamelCase.

## Commit & Pull Request Guidelines
- PRs should describe changes, list commands run, and update examples if behavior changes.
