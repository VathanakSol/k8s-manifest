# phpIPAM on Kubernetes (Kustomize, with HPA + VPA)

## Layout

```
phpipam/
├── base/                     web Deployment, Service, ConfigMap, PDB, Namespace
├── components/
│   ├── mariadb/              in-cluster MariaDB StatefulSet + schema init (SCHEMA.sql)
│   ├── scheduler/            phpipam-cron (scans/discovery), single replica
│   ├── autoscaling/          HPA + VPA
│   └── gateway/              optional Envoy Gateway (Gateway API) exposure
├── overlays/dev/             ready-to-deploy overlay (+ secret templates)
├── cluster-autoscaler/       node scale-down tuning (patch for kube-system, applied separately)
└── tests/                    manual VPA/node-scale-up test, NOT part of the overlay
```

`cluster-autoscaler/` is not part of `kubectl apply -k`. It patches the
cluster-wide autoscaler in `kube-system`, so it affects every app on the cluster,
not only phpIPAM. See [Node autoscaling](#node-autoscaling).

## Autoscaling design

| Workload            | HPA                         | VPA                                   |
|---------------------|-----------------------------|---------------------------------------|
| `phpipam-web`       | 2–6 replicas, CPU 70%       | `Recreate`, **memory only** (192Mi–1Gi) |
| `phpipam-mariadb`   | none (single-instance DB)   | `Off`: recommendations only           |
| `phpipam-scheduler` | none (must stay 1 replica)  | `Off`: recommendations only           |

The HPA and the VPA must not both act on CPU for the same pods. If the VPA raises
the CPU request, the HPA's utilisation percentage drops, so the HPA scales in
while the VPA keeps resizing, and the two fight. Here the HPA owns CPU (replica
count) and the VPA owns memory (pod size). The autoscaling component removes
`spec.replicas` from the web Deployment, so `kubectl apply` never resets the
replica count the HPA has chosen. The PDB (`maxUnavailable: 1`) and
`minReplicas: 2` keep the UI up during VPA evictions and node drains.

phpIPAM's Docker image stores PHP sessions in the database, so users stay logged
in when requests land on different web replicas. No sticky sessions are needed.

## Node autoscaling

When the HPA adds web pods that don't fit on the existing nodes, the cluster
autoscaler (installed by CloudStack) adds worker VMs. When load drops, the HPA
removes pods and the autoscaler removes idle workers. With the patch in
`cluster-autoscaler/`:

- a worker is removed after it has been idle for **5 minutes**;
- workers are removed **one at a time, about 5 minutes apart**;
- the autoscaler itself runs on the control-plane node, so it never blocks
  the removal of a worker.

"Idle" means the CPU and memory **reserved** (pod requests) on the node are below
50% of its capacity. Actual CPU usage doesn't count.

```bash
kubectl -n kube-system patch deploy cluster-autoscaler \
  --patch-file phpipam/cluster-autoscaler/scale-down-patch.yaml
```

Run it from the repository root. Re-run it whenever autoscaling settings are
changed in CloudStack, because CloudStack may overwrite the autoscaler's
configuration. The `--nodes=min:max:<cluster-id>` line in the patch is specific
to this cluster; update it for another cluster.

## Prerequisites

1. **metrics-server**, required by the HPA. Check: `kubectl top pods -A`
2. **VPA controllers**. Installing the CRDs alone does nothing. You need the
   recommender, updater and admission-controller:
   ```bash
   git clone https://github.com/kubernetes/autoscaler.git
   cd autoscaler/vertical-pod-autoscaler
   ./hack/vpa-up.sh          # needs bash + openssl; run from Linux/WSL
   kubectl -n kube-system get pods | grep vpa   # expect 3 pods Running
   ```
3. A StorageClass for MariaDB. The default is `local-path`; edit
   `components/mariadb/statefulset.yaml` if yours differs.

## Deploy

```bash
cd phpipam/overlays/dev
cp secrets/db.env.example           secrets/db.env
cp secrets/mariadb-root.env.example secrets/mariadb-root.env
# edit both files and set strong passwords (these files are git-ignored)

kubectl kustomize .                  # review the rendered output
kubectl apply -k .
kubectl -n phpipam get pods,hpa,vpa
```

On first start, MariaDB loads `SCHEMA.sql` automatically. Then open the UI
(port-forward, or the gateway component) and log in as `Admin` / `ipamadmin` (phpIPAM's default account).
**Change that password right away.**

```bash
kubectl -n phpipam port-forward svc/phpipam-web 8080:80   # http://localhost:8080
```

### Options

- **External database**: remove `components/mariadb` from the overlay, set
  `IPAM_DATABASE_HOST` in `base/configmap.yaml`, import `SCHEMA.sql` into that
  database yourself, and drop `phpipam-mariadb-root` from the `secretGenerator`.
- **Expose via Envoy Gateway**: set the hostname in
  `components/gateway/httproute.yaml`, then uncomment the gateway component.
  This also sets `IPAM_TRUST_X_FORWARDED=true`.
- **VPA mode for web**: in `components/autoscaling/vpa.yaml`, use `Off` to only
  watch recommendations first. On VPA >= 1.4, `InPlaceOrRecreate` resizes
  without a restart where possible.

## Verify autoscaling

```bash
kubectl -n phpipam describe vpa phpipam-web        # "Recommendation" appears after a few minutes
kubectl -n phpipam get hpa phpipam-web -w
# generate load (inside the cluster):
kubectl -n phpipam run load --rm -it --image=busybox:1.36 --restart=Never -- \
  sh -c 'while true; do wget -q -O- http://phpipam-web/ >/dev/null; done'
```

## Notes

- Images are pinned (`phpipam-www`/`phpipam-cron` `v1.9.1`, `mariadb:11.4.13`).
  Upgrade by bumping the tags. Back up the database before a phpIPAM upgrade.
- Passwords in `secrets/*.env` are applied only on the **first** MariaDB init.
  Changing them later needs an `ALTER USER` inside MariaDB as well.
- `SCHEMA.sql` runs only when the MariaDB volume is empty.
