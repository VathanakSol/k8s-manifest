# Zabbix 7.0 LTS on Kubernetes (Kustomize, with HPA + VPA)

## Layout

```
zabbix/
├── base/                         server Deployment + Service, web Deployment + Service,
│                                 ConfigMaps, PDB, Namespace
├── components/
│   ├── mariadb/                  in-cluster MariaDB StatefulSet (utf8mb4_bin)
│   ├── autoscaling/              HPA (web, CPU); needs metrics-server
│   ├── vpa/                      optional VPA; needs the VPA installed in the cluster
│   ├── agent/                    zabbix-agent2 DaemonSet, monitors the K8s nodes
│   ├── gateway/                  optional Envoy Gateway (Gateway API) exposure of the UI
│   └── server-loadbalancer/      optional LoadBalancer for port 10051 (external agents/proxies)
└── overlays/dev/                 ready-to-deploy overlay (+ secret templates)
```

## Architecture

```
 browser ──► zabbix-web (2–6 pods, nginx+php) ──┐
                     │ 10051                    │ 3306
                     ▼                          ▼
 agents ───► zabbix-server (1 pod) ─────────► zabbix-mariadb (1 pod, PVC)
 (active)       polls SNMP/ICMP/agents
```

| Workload         | HPA                          | VPA                                     |
|------------------|------------------------------|-----------------------------------------|
| `zabbix-web`     | 2–6 replicas, CPU 70%        | `Recreate`, **memory only** (192Mi–1Gi) |
| `zabbix-server`  | none (must stay 1 replica)   | `Off`: recommendations only             |
| `zabbix-mariadb` | none (single-instance DB)    | `Off`: recommendations only             |
| `zabbix-agent`   | DaemonSet (one per node)     | none                                    |

- **zabbix-server** must run as exactly one pod (`Recreate` strategy). Two plain
  servers on one database would both poll and write duplicate data.
- **zabbix-web** is stateless. Sessions are signed cookies checked against the
  database, so no sticky sessions are needed, and the web tier can scale.
- The HPA owns web CPU (replica count) and the VPA owns web memory (pod size), so
  they don't fight, as in the phpIPAM setup.

## Prerequisites

1. **metrics-server**, required by the HPA. Without it the HPA shows
   `cpu: <unknown>` and never scales. Check: `kubectl top nodes`
   ```bash
   kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
   ```
2. **VPA controllers** (recommender, updater, admission-controller), only for
   `components/vpa`, which is disabled by default. If you enable it without the
   VPA installed, `kubectl apply` fails with
   `no matches for kind "VerticalPodAutoscaler"`. See the phpIPAM README for the
   install. Check: `kubectl get crd verticalpodautoscalers.autoscaling.k8s.io`
3. A StorageClass for MariaDB. The default is `local-path`; edit
   `components/mariadb/statefulset.yaml` if yours differs.

## Deploy, step by step

### 1. Create the secrets (local, git-ignored)

```bash
cd zabbix/overlays/dev
cp secrets/db.env.example           secrets/db.env
cp secrets/mariadb-root.env.example secrets/mariadb-root.env
# edit both files and set strong passwords
```

### 2. Review what will be applied

```bash
kubectl kustomize .
```

### 3. Apply

```bash
kubectl apply -k .
```

### 4. Watch the first start

```bash
kubectl -n zabbix get pods -w
kubectl -n zabbix logs deploy/zabbix-server -f
```

Order of events on the first start:

1. `zabbix-mariadb` initialises an empty database and the `zabbix` user.
2. `zabbix-server` waits for the DB, sees no schema, and **imports the Zabbix
   schema and default data**. This takes 2–5 minutes; the startup probe allows 10.
   In the log, look for `** Creating 'zabbix' schema in MySQL` and then
   `Starting Zabbix Server`.
3. `zabbix-web` pods become Ready once the schema exists.

`zabbix-web` may restart or show "Database error" until step 2 finishes. That is
expected.

### 5. Log in

```bash
kubectl -n zabbix port-forward svc/zabbix-web 8080:80   # http://localhost:8080
```

Default account: `Admin` / `zabbix`. **Change that password right away**
(User settings → Profile → Change password).

### 6. Fix the built-in "Zabbix server" host

The default database contains a host named **Zabbix server** that expects an
agent on `127.0.0.1:10050`. No agent runs in the server pod, so it shows as
unavailable. Use one of these fixes:

- Data collection → Hosts → *Zabbix server* → remove the *Linux by Zabbix agent*
  template and keep only *Zabbix server health* (internal checks, no agent
  needed), **or**
- disable the host.

### 7. Monitor the nodes (agent component)

The `zabbix-agent` DaemonSet runs on every node in **active** mode with
`HostMetadata=k8s-node` and host name = node name. Let the server create the
hosts automatically:

Alerts → Actions → **Autoregistration actions** → Create action

- Condition: *Host metadata* **contains** `k8s-node`
- Operations:
  - Add host
  - Add to host groups: `Kubernetes nodes` (create it first)
  - Link templates: **Linux by Zabbix agent active**

Within about a minute, each node shows up under Data collection → Hosts.

```bash
kubectl -n zabbix get ds zabbix-agent
kubectl -n zabbix logs ds/zabbix-agent | grep -i "active"
```

Limitation: the agent shares the node's network and PIDs, but not its filesystem
mounts. Filesystem discovery reports the container's mounts, not the node's disks.

## Options

- **External database**: remove `components/mariadb` from the overlay and set
  `DB_SERVER_HOST` in `base/configmap.yaml`. Create the database first:
  `CREATE DATABASE zabbix CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;` and grant
  the `zabbix` user all privileges on it. The server imports the schema on first
  start. Drop `zabbix-mariadb-root` from the `secretGenerator`.
- **Expose the UI via Envoy Gateway**: set the hostname in
  `components/gateway/httproute.yaml`, then uncomment the gateway component.
- **Agents/proxies outside the cluster**: set `loadBalancerSourceRanges` in
  `components/server-loadbalancer/kustomization.yaml`, uncomment the component,
  then read the external IP with `kubectl -n zabbix get svc zabbix-server`.
  Point the agents' `ServerActive=` at that IP. Use PSK encryption over
  untrusted networks.
- **Server tuning**: edit `zabbix-server-config` in `base/configmap.yaml`
  (`ZBX_CACHESIZE`, `ZBX_STARTPOLLERS`, …; each maps to `zabbix_server.conf`).
  Raise the server's memory limit if you raise the caches. Then run
  `kubectl -n zabbix rollout restart deploy/zabbix-server`, because env changes
  in a ConfigMap don't restart pods by themselves.
- **Time zone**: `TZ`/`PHP_TZ` in `base/configmap.yaml`. Each user can also set
  their own in their profile.

## Verify autoscaling

```bash
kubectl -n zabbix get hpa,vpa
kubectl -n zabbix describe vpa zabbix-web       # "Recommendation" appears after a few minutes
kubectl -n zabbix describe vpa zabbix-server    # use to size the server by hand
kubectl -n zabbix run load --rm -it --image=busybox:1.36 --restart=Never -- \
  sh -c 'while true; do wget -q -O- http://zabbix-web/ >/dev/null; done'
```

## Notes

- Images are pinned: `zabbix-*:alpine-7.0.32` and `mariadb:11.4.13`. Keep server,
  web and agent on the same Zabbix version. To upgrade, back up the database,
  bump all three tags, and apply. The server upgrades the DB schema itself on
  start (minor 7.0.x upgrades need no schema change).
- Passwords in `secrets/*.env` are applied only on the **first** MariaDB init.
  Changing them later needs an `ALTER USER` inside MariaDB as well.
- Database size grows with hosts × items × history/trend retention. Watch PVC
  usage and adjust housekeeping (Administration → Housekeeping).
- Backup example:
  ```bash
  kubectl -n zabbix exec zabbix-mariadb-0 -- sh -c \
    'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction zabbix' \
    | gzip > zabbix-$(date +%F).sql.gz
  ```
