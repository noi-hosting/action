noi-hosting/actions
===================

A repository containing a various GitHub actions used with [noi-hosting.de](https://noi-hosting.de).

Included actions:
-----------------

- **[noi-hosting/action/deploy](./deploy/action.yml):** Main workflow for deploying
- **[noi-hosting/action/sync](./sync/action.yml):** Main workflow for syncing environments
- **[noi-hosting/action/read-config](./read-config/action.yml):** Internal action for config validation
- **[noi-hosting/action/setup](./read-config/setup.yml):** Internal action for preparing webspaces (can be used standalone)

[See the documentation](https://docs.noi-hosting.de) for learning how to configure the GitHub actions. 


Internal notes
--------------

**Build before commit:**

```bash
pnpm all
```
