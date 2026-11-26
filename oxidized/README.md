# Oxidized on Kubernetes (Kustomize)

[Oxidized](https://github.com/ytti/oxidized) logs in to network devices over
SSH/telnet on a schedule, fetches their running configuration and commits each
change to a git repository. The web UI shows every device, its last backup
status and the diff history.

## Layout

```
oxidized/
├── base/                     Deployment, Service, PVC, Namespace, config.yaml (-> ConfigMap)
├── components/
│   ├── autoscaling/          VPA, recommendations only (no HPA: singleton)
│   └── gateway/              optional Envoy Gateway exposure + basic auth
└── overlays/dev/             ready-to-deploy overlay (+ router.db template)
```

## How it fits together

| Path in the pod                       | Source                              | Mode       |
|---------------------------------------|-------------------------------------|------------|
| `/etc/oxidized/config`                | ConfigMap `oxidized-config-<hash>`  | read-only  |
| `/etc/oxidized/router.db`             | Secret `oxidized-router-db`         | read-only  |
| `/home/oxidized/.config/oxidized/`    | PVC `oxidized-data` (git repo, pid, crashes) | read-write |

- `OXIDIZED_HOME=/etc/oxidized` tells Oxidized where to read its config.
  All writable paths in `config.yaml` point at the PVC.
- **Config change** (`base/config.yaml`): the ConfigMap name gets a new hash,
  so the Deployment changes and the pod restarts.
- **Device change** (`secrets/router.db`): the Secret keeps its name and the
  file inside the pod updates in place (~1 min). `CONFIG_RELOAD_INTERVAL=300`
  then calls `/reload`, so new devices appear within ~5 minutes, no restart needed.
- **One replica, `Recreate` strategy.** Two pods would back up every device
  twice and write to the same git repo. The volume is ReadWriteOnce anyway.

## Prerequisites

1. **Network reachability**: the cluster nodes (pod egress) must reach the
   devices' management IPs on TCP 22 (or 23 for telnet). Check from a pod:
   ```bash
   kubectl run nettest --rm -it --image=busybox:1.36 --restart=Never -- \
     nc -zv -w 3 10.0.0.1 22
   ```
2. **A backup account on each device** with read access to the running
   config (for example Cisco `privilege 15` or `show running-config` only).
3. A StorageClass for the PVC. The default is `local-path`; edit
   `base/pvc.yaml` if yours differs.
4. For `components/autoscaling`: the VPA recommender (see `phpipam/README.md`).

## Deploy

```bash
cd oxidized/overlays/dev
cp secrets/router.db.example secrets/router.db
# edit secrets/router.db: one device per line (this file is git-ignored)
#   name:ip:model:username:password:enable

kubectl kustomize .                  # review the rendered output
kubectl apply -k .
kubectl -n oxidized get pods,pvc
kubectl -n oxidized logs deploy/oxidized -f
```

Open the UI:

```bash
kubectl -n oxidized port-forward svc/oxidized 8888:8888   # http://localhost:8888
```

A device that has been backed up shows status `success`. To back up one device
right away without waiting for `interval`:

```bash
curl -s http://localhost:8888/node/next/core-sw01
```

### Add or change devices

```bash
cd oxidized/overlays/dev
vi secrets/router.db
kubectl apply -k .          # updates the Secret; Oxidized reloads within ~5 min
```

To reload right away: `curl -s http://localhost:8888/reload` (with the port-forward running).

### Options

- **Expose via Envoy Gateway**: oxidized-web has **no login**, and it shows
  full device configs. The gateway component therefore always adds basic auth.
  1. Set the hostname in `components/gateway/httproute.yaml`.
  2. `htpasswd -nbs admin 'your-password' > overlays/dev/secrets/htpasswd`
     (SHA hashes only; `htpasswd` comes from `apache2-utils`).
  3. In `overlays/dev/kustomization.yaml`, uncomment the gateway component
     and the `oxidized-basic-auth` secretGenerator entry.
  4. Add an HTTPS listener in `gateway.yaml` outside a trusted network.
- **Backup interval**: `interval` in `base/config.yaml` (seconds).
- **Device models**: see the
  [supported OS list](https://github.com/ytti/oxidized/blob/master/docs/Supported-OS-Types.md).
  Use the model name exactly as listed (for example `ios`, `nxos`, `junos`, `routeros`, `fortios`).
- **Push backups to a remote git server**: add a `githubrepo` hook in
  `base/config.yaml` and mount an SSH deploy key. See the
  [hooks docs](https://github.com/ytti/oxidized/blob/master/docs/Hooks.md).
- **Use phpIPAM as the device source** instead of `router.db`: switch
  `source.default` to `http` and point it at the phpIPAM API. Credentials
  then go in `groups`/`models` in the config (which should become a Secret).

## Notes

- The image is pinned (`oxidized/oxidized:0.38.0`). Upgrade by bumping the tag.
- The PVC holds the whole configuration history (`configs.git`). Back it up,
  or push it to a remote git server (see Options).
- `router.db` fields are `:`-separated, so passwords must not contain `:`.
  IPv6 addresses don't work either: use a DNS name and set `resolve_dns: true`.
- `input.ssh.secure: false` accepts changed SSH host keys. Set it to `true`
  once all devices are known, to detect man-in-the-middle attempts.
- The container starts as root (runit), fixes ownership of the data
  directory, then runs Oxidized as UID 30000. `runAsNonRoot` can't be used.
