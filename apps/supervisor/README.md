# Supervisor

## Dev setup

1. Create a worker group

```sh
api_url=http://localhost:3030
wg_name=my-worker

# edit this
admin_pat=tr_pat_...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\"}"
```

If the worker group is newly created, the response will include a `token` field. If the group already exists, no token is returned.

2. Create `.env` and set the worker token

```sh
cp .env.example .env

# Then edit your .env and set this to the token.plaintext value
TRIGGER_WORKER_TOKEN=tr_wgt_...
```

3. Start the supervisor

```sh
pnpm dev
```

4. Build CLI, then deploy a test project

```sh
pnpm exec trigger deploy --self-hosted

# The additional network flag is required on linux
pnpm exec trigger deploy --self-hosted --network host
```

## Worker group management

### Shared variables

```sh
api_url=http://localhost:3030
admin_pat=tr_pat_... # edit this
```

- These are used by all commands

### Create a worker group

```sh
wg_name=my-worker

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\"}"
```

- If the worker group already exists, no token will be returned

### Set a worker group as default for a project

```sh
wg_name=my-worker
project_id=clsw6q8wz...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$wg_name\", \"projectId\": \"$project_id\", \"makeDefaultForProject\": true}"
```

- If the worker group doesn't exist, yet it will be created
- If the worker group already exists, it will be attached to the project as default. No token will be returned.

### Remove the default worker group from a project

```sh
project_id=clsw6q8wz...

curl -sS \
    -X POST \
    "$api_url/admin/api/v1/workers" \
    -H "Authorization: Bearer $admin_pat" \
    -H "Content-Type: application/json" \
    -d "{\"projectId\": \"$project_id\", \"removeDefaultFromProject\": true}"
```

- The project will then use the global default again
- When `removeDefaultFromProject: true` no other actions will be performed

## Per-run credential provider

The supervisor can mint a short-lived, run-scoped credential for each worker and
inject it into that single pod/container at creation time. The worker then boots
holding only that scoped credential instead of an ambient/admin credential baked
into the image — the basis for per-tenant isolation (a worker for org A cannot
reach org B's data because its credential is scoped to A).

The mechanism is tenant-agnostic: the supervisor forwards the run context it has
to an HTTP endpoint you provide, and injects whatever env vars that endpoint
returns. All tenant mapping and signing lives in your endpoint.

### Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `RUN_CREDENTIAL_PROVIDER_URL` | _(unset)_ | Mint endpoint. Unset = feature off (behavior is identical to not having it). |
| `RUN_CREDENTIAL_PROVIDER_TOKEN` | _(unset)_ | Bearer token the supervisor presents to authenticate itself. This is the supervisor's own credential and is **never** forwarded to the worker. |
| `RUN_CREDENTIAL_PROVIDER_TIMEOUT_MS` | `5000` | Timeout for the mint call. |
| `RUN_CREDENTIAL_PROVIDER_FAIL_OPEN` | `false` | When `false` (default) a mint failure aborts pod creation (fail closed). When `true` the pod is created without run credentials. |

### Contract

The supervisor `POST`s to `RUN_CREDENTIAL_PROVIDER_URL`:

```jsonc
{
  "context": {
    "runId": "run_...",
    "runFriendlyId": "run_...",
    "isTest": false,
    "isReplay": false,
    "orgId": "org_...",        // Trigger.dev organization id
    "projectId": "proj_...",
    "envId": "env_...",
    "envType": "PRODUCTION",
    "deploymentFriendlyId": "deployment_...",
    "deploymentVersion": "20260101.1",
    "annotations": { "triggerSource": "api", "triggerAction": "trigger" }
  }
}
```

Note: the task payload and run metadata never reach the supervisor, so they are
not in the context. Map these identifiers to whatever scope your enforcement
layer uses (e.g. Trigger project/env → your customer org) inside the endpoint.

The endpoint returns the env vars to inject:

```jsonc
{
  "env": { "MY_APP_TOKEN": "<short-lived-scoped-token>" },
  "bindsPodToRun": true   // optional, defaults to true
}
```

### Warm start / checkpoints

Because the credential is baked into the pod's static env at creation, a reused
warm pod or a restored checkpoint would carry a previous run's credential. When
`RUN_CREDENTIAL_PROVIDER_URL` is set the supervisor therefore **skips warm start
and checkpoint restore** for every run, so each run always cold-starts with its
own credential. Expect higher pod churn and cold-start latency in exchange for
per-run credential isolation.
