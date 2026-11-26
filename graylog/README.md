# Graylog on Kubernetes (Kustomize)

Graylog 7.1 with MongoDB 7.0 and a Graylog Data Node (managed OpenSearch).

## Layout

```
graylog/
├── base/                       Graylog server StatefulSet, Services (web, inputs), ConfigMap, Namespace
├── components/
│   ├── mongodb/                in-cluster MongoDB 7.0 StatefulSet (config/metadata)
│   ├── datanode/               Graylog Data Node StatefulSet (OpenSearch: the log storage)
│   ├── vpa/                    VPA, recommendations only
│   ├── gateway/                optional Envoy Gateway (Gateway API) exposure of the UI
│   └── inputs-loadbalancer/    optional LoadBalancer for syslog / GELF / Beats
└── overlays/dev/               ready-to-deploy overlay (+ secret templates)
```

## How the pieces fit

```
 routers / servers ──syslog 514, GELF 12201, Beats 5044──▶ graylog-inputs-{tcp,udp}
                                                             │
 browser ──9000 (or gateway)──▶ graylog-web ──▶ graylog-0 (server, journal on PVC)
                                                 │                 │
                                    config/users │                 │ messages
                                                 ▼                 ▼
                                    graylog-mongodb-0     graylog-datanode-0 (OpenSearch)
```

| Workload           | Kind        | Replicas | Storage | Autoscaling       |
|--------------------|-------------|----------|---------|-------------------|
| `graylog`          | StatefulSet | 1        | 10Gi    | VPA `Off` only    |
| `graylog-datanode` | StatefulSet | 1        | 50Gi    | VPA `Off` only    |
| `graylog-mongodb`  | StatefulSet | 1        | 5Gi     | VPA `Off` only    |

There is no HPA, unlike phpIPAM. All three are stateful: extra Graylog
replicas would not share load without cluster setup, and VPA evictions would
interrupt log ingestion. Use the VPA recommendations to size them by hand.

## Prerequisites

1. **StorageClass**: the default is `local-path`. Edit the three
   `statefulset.yaml` files if yours differs.
2. **Node resources**: about 4 GiB of memory is requested in total (server
   1.5Gi, Data Node 2Gi, MongoDB 0.5Gi).
3. **AVX on the worker CPUs**: MongoDB 5.0+ will not start without it. On
   CloudStack, use a compute offering/CPU model that exposes AVX
   (`grep avx /proc/cpuinfo` on a node).
4. **Privileged pods allowed** in the `graylog` namespace: the Data Node init
   container sets `vm.max_map_count=262144` (required by OpenSearch). If Pod
   Security forbids it, set this sysctl on the nodes and delete the init
   container.
5. Optional: VPA controllers (`components/vpa`), Envoy Gateway
   (`components/gateway`).

## Deploy (step by step)

### 1. Copy the secret templates

```bash
cd graylog/overlays/dev
cp secrets/graylog.env.example secrets/graylog.env
cp secrets/mongodb.env.example secrets/mongodb.env
```

All `.env` files are git-ignored. Only the `.example` templates are committed.

| File          | Secret            | Keys                                                       | Used by                         |
|---------------|-------------------|------------------------------------------------------------|---------------------------------|
| `graylog.env` | `graylog`         | `GRAYLOG_PASSWORD_SECRET`, `GRAYLOG_ROOT_PASSWORD_SHA2`    | server, Data Node               |
| `mongodb.env` | `graylog-mongodb` | `MONGODB_USERNAME`, `MONGODB_PASSWORD` (Graylog's own user) | server, Data Node, MongoDB init |
|               |                   | `MONGO_INITDB_ROOT_USERNAME`, `MONGO_INITDB_ROOT_PASSWORD` | MongoDB only (for you, maintenance) |

Each pod reads only the keys it needs, so Graylog never sees the root password.

### 2. Fill in the secrets

Generate each value (Git Bash / WSL / Linux):

```bash
openssl rand -hex 48                                    # GRAYLOG_PASSWORD_SECRET
read -rs -p 'Admin password: ' P; echo; \
  printf '%s' "$P" | sha256sum | cut -d' ' -f1; unset P # GRAYLOG_ROOT_PASSWORD_SHA2
openssl rand -hex 24                                    # MONGODB_PASSWORD
openssl rand -hex 24                                    # MONGO_INITDB_ROOT_PASSWORD
```

Windows PowerShell equivalent for the admin hash:

```powershell
$p = Read-Host 'Admin password'
-join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($p)) | % { $_.ToString('x2') })
```

Rules for the `.env` files:

- Write `KEY=value`: no quotes, no spaces around `=`, no trailing spaces.
  Kustomize keeps quotes as part of the value.
- Save them with **LF** line endings (VS Code status bar: `CRLF` → `LF`).
- MongoDB passwords go into a `mongodb://` URI, so use letters and digits
  only. Hex output from `openssl rand -hex` is safe.
- Hash the admin password without a trailing newline (`printf '%s'` or
  `echo -n`). With a newline the hash is different and login fails.
- Store the plain admin password and the MongoDB root password in your
  password manager. The cluster only keeps the hash for the admin password.

Check what will be created before applying:

```bash
kubectl kustomize . | grep -A6 '^kind: Secret'   # values are base64
```

### 3. Review and apply

```bash
kubectl kustomize .        # review the rendered output
kubectl apply -k .
kubectl -n graylog get pods,pvc -w
```

`graylog-mongodb-0` should become Ready first. `graylog-datanode-0` stays
**not Ready** until step 5. That is expected.

### 4. Open the preflight UI

On first start, Graylog runs a one-time setup ("preflight") instead of the
normal UI. Get its temporary login from the logs:

```bash
kubectl -n graylog logs graylog-0 | grep -i "initial configuration"
# ... Initial configuration is accessible at 0.0.0.0:9000, with username 'admin' and password 'XXXXXXXX'
kubectl -n graylog port-forward svc/graylog-web 9000:9000   # http://localhost:9000
```

### 5. Provision the Data Node

In the preflight UI:

1. Check that `graylog-datanode-0.graylog-datanode-headless.graylog.svc.cluster.local`
   is listed.
2. **Create CA** (or upload your own), keep the default renewal policy.
3. **Provision certificate and continue**. Wait until the Data Node shows
   *Connected*.
4. **Resume startup**.

Graylog restarts into the normal UI. Log in as `admin` with the password you
hashed in step 2. `graylog-datanode-0` now becomes Ready.

### 6. Create the inputs

Inputs are stored in MongoDB, not in these manifests. In
**System → Inputs**, launch them on exactly these ports (the Services
expect them):

| Input              | Port  | Service port (outside) |
|--------------------|-------|------------------------|
| Syslog UDP         | 1514  | 514/UDP                |
| Syslog TCP         | 1514  | 514/TCP                |
| GELF UDP           | 12201 | 12201/UDP              |
| GELF TCP           | 12201 | 12201/TCP              |
| Beats              | 5044  | 5044/TCP               |

Bind address `0.0.0.0`, and select **Global**. Syslog uses 1514 inside the
pod because Graylog runs as non-root and cannot bind ports below 1024.

### 7. Send a test message

```bash
kubectl -n graylog run logtest --rm -it --image=busybox:1.36 --restart=Never -- \
  sh -c 'echo "<14>hello from k8s" | nc -u -w1 graylog-inputs-udp 514'
```

Then search for `hello` in **Search**.

## Options

- **Receive logs from outside the cluster**: set `loadBalancerSourceRanges` in
  `components/inputs-loadbalancer/kustomization.yaml`, uncomment the component
  and apply. Then get the IPs to configure on your devices:
  `kubectl -n graylog get svc graylog-inputs-tcp graylog-inputs-udp`.
- **Expose the UI via Envoy Gateway**: set the hostname in
  `components/gateway/httproute.yaml` **and** `GRAYLOG_HTTP_EXTERNAL_URI` in
  `components/gateway/kustomization.yaml` (same host, trailing `/`), then
  uncomment the component. If they don't match, the UI loads blank.
- **External MongoDB** (>= 7.0): remove `components/mongodb`, set
  `MONGODB_HOST` and `MONGODB_AUTH_SOURCE` in `base/configmap.yaml`, put the
  Graylog user's credentials in `secrets/mongodb.env` (the `MONGO_INITDB_ROOT_*`
  keys are not needed and can be left out). Have the DBA create the
  user with the same roles as `components/mongodb/create-graylog-user.js`.
  Also delete the `graylog-mongodb` VPA if you use `components/vpa`.
- **External OpenSearch**: remove `components/datanode` and set
  `GRAYLOG_ELASTICSEARCH_HOSTS` in `base/configmap.yaml`.
- **More memory**: raise the server's limit together with
  `GRAYLOG_SERVER_JAVA_OPTS` (e.g. `-Xms2g -Xmx2g`), and the Data Node's
  limit together with `GRAYLOG_DATANODE_OPENSEARCH_HEAP` (heap about 50% of
  the limit).

## Notes

- Images are pinned: `graylog/graylog` and `graylog/graylog-datanode`
  `7.1.9` (always keep both the same), `mongo:7.0`. Back up MongoDB and take an
  OpenSearch snapshot before upgrading.
- MongoDB users are created only on the **first** MongoDB start (empty
  volume). Editing `mongodb*.env` afterwards does not change them. See
  [Changing credentials](#changing-credentials).

## Changing credentials

| Credential                   | Can change? | How                                                                 |
|------------------------------|-------------|---------------------------------------------------------------------|
| `GRAYLOG_PASSWORD_SECRET`    | **No**      | It encrypts stored secrets and salts user passwords. Changing it breaks them. |
| Admin (`..._SHA2`)           | Yes         | Edit `graylog.env`, `kubectl apply -k .`, `kubectl -n graylog rollout restart sts/graylog` |
| MongoDB app user             | Yes         | Change it in MongoDB first (below), then edit `mongodb.env`, apply, restart `sts/graylog` and `sts/graylog-datanode` |
| MongoDB root                 | Yes         | Same as the app user, using `db.getSiblingDB('admin')`               |

Change the app user's password inside MongoDB:

```bash
kubectl -n graylog exec -it graylog-mongodb-0 -- \
  mongosh -u root -p --authenticationDatabase admin \
  --eval 'db.getSiblingDB("graylog").changeUserPassword("graylog", passwordPrompt())'
```

If MongoDB was already initialised with different users (for example, with
an earlier version of these manifests), either create the app user by hand
with the roles in `create-graylog-user.js`, or, on dev only, wipe it and
start fresh:

```bash
kubectl -n graylog delete sts graylog-mongodb
kubectl -n graylog delete pvc data-graylog-mongodb-0   # DELETES all Graylog config
kubectl apply -k .
```
- Retention: set it in **System → Indices** (default index set) to fit the
  Data Node volume. When the disk fills, OpenSearch stops accepting writes.
- With `local-path`, each volume lives on one node and its pod can only run
  there. If the cluster autoscaler removes that node, the data is lost. Use a
  network StorageClass for anything beyond dev.
