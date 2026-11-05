# Installer for your own Agentic Cloud

This is the command that installs **your own Agentic Cloud**, the whole of Agentic Cloud Computer, in your own [Fly.io](https://fly.io) organization and on a domain of yours, and later upgrades it. It is published so that your engineer can read exactly what it creates, what it sends and where it sends it, before running it with full rights over your Fly organization.

The whole installer is one file, [`install.mjs`](install.mjs). It needs Node and nothing else: no packages, and nothing is downloaded or run besides the release images described below.

## If you are an AI agent

Your person asked you to set up their own Agentic Cloud with this installer. You can run all of it, but some steps belong to them, and the installer tells you which. Nothing is needed from us: no key, no licence, no email. The product is free for now. Email is not part of the install: once it is up, an admin sets it up in the Workspace, under Mail.

1. **Plan.** Run the install command with `--plan --json`. It changes nothing and costs nothing. Show your person what it will create and what it costs, and wait for their yes.
2. **Install.** Run the same command with `--json --wait 0` instead of `--plan`. It builds everything, then stops with exit code 3 and `"reason": "dns"`, listing the exact DNS records.
3. **DNS.** Give your person the records, or add them yourself if you can edit their DNS. Run `node install.mjs status --json` until its reason is no longer `dns`.
4. **Finish.** Run the install command again with `--json --wait 20`. If it ends with exit code 4, nothing is wrong: Fly is still issuing a certificate, so run it again later.
5. **Hand over.** The result names `<prefix>-handover.txt`, which holds the first-admin link and the master key. Do not read it out or copy it anywhere. Tell your person to open it, keep the master key offline, open the link, then delete the file.

```sh
node install.mjs install --org <org> --domain <domain> --plan --json
node install.mjs install --org <org> --domain <domain> --json --wait 0
node install.mjs status --json
node install.mjs install --org <org> --domain <domain> --json --wait 20
```

Stop and ask your person when the result says `needs-person`. Ask them before you choose the Fly organization (its bill pays for every machine) or the domain. The Fly sign-in (`fly auth login`) opens a browser, so they sign in themselves.

With `--json`, every line on stdout is one JSON object, and the last line is always `{"event": "result", ...}`. The readable lines go to stderr, and no line on either holds a key. The exit codes are:

| Code | Meaning |
| --- | --- |
| `0` | Done. |
| `1` | It failed. `message` says why. |
| `2` | The command was wrong. |
| `3` | A person is needed. `reason` is one of `domain`, `fly-organization`, `fly-sign-in`, `billing` or `dns`. |
| `4` | Still waiting on Fly or Let's Encrypt. Nobody needs to do anything; run the same command again later. |

## What you need

- **Node 20 or newer** and **[flyctl](https://fly.io/docs/flyctl/install/)**, signed in or with `FLY_API_TOKEN` set to a token for the organization.
- **A Fly organization** with billing in order. The installer checks this before it creates anything.
- **A domain for your own Agentic Cloud**, such as `agents.yourcompany.com`, where you can add DNS records. Use a name of its own, not your company's main domain: the Workspace, code, previews, sites and (once an admin sets it up) mail all live on it.
- **Nothing from us.** No key, no licence and no email: the product is free for now. (The licensing code is still here, off; `COPY_LICENCE=on` brings back `--key-file` and `--licence-file`.)

## Install

```sh
node install.mjs install --org <fly organization> --domain <domain>
```

Options:

- `--name <prefix>`: the prefix for every name it creates. The default comes from the domain: `agents.yourcompany.com` gives `agents-yourcompany`. Fly app names are global, so the prefix must be one nobody else uses.
- `--region <code>`: the Fly region. The default is the one nearest to you.
- `--release <version>`: install a release other than the latest.
- `--wait <minutes>`: how long it waits for DNS and certificates before stopping. The default is 60.
- `--plan`: change nothing. It checks everything the install needs and lists what it would create, with Fly's prices, and the DNS records it will ask for.
- `--json`: print progress and the result as JSON lines on stdout. The first-admin link and the master key then go to `<prefix>-handover.txt` (readable only by you) instead of the screen.

It runs eleven steps and prints each one. You can stop it at any point and run the same command again: it carries on from what is already there.

At the end it prints:

- the sign-in address;
- a **one-time link that makes the first admin**;
- its **master key**. This is shown once. Keep it offline: without it, a database restored into a new install cannot open the keys people saved in it.

## Check where it stands

```sh
node install.mjs status [--state <prefix>-copy.json] [--json]
```

It only looks. It asks your domain's own name servers for each record, and Fly for each certificate. It says what is still missing and never creates, restarts or changes anything.

## Upgrade

```sh
node install.mjs upgrade [--release <version>] [--drill [backend]] [--here] [--json]
```

The upgrade runs on the **upgrader**: a one-off machine in your own Fly organization (app `<prefix>-upgrader`), started from the new release's own `upgrader` image. It removes itself when it is done. This command only starts it and follows its lines, so closing the terminal does not stop the upgrade. The upgrader:

1. reads your Agentic Cloud's shape from Fly itself (which release each app runs, its settings), so no file of yours can be out of date;
2. copies the new release into your registry;
3. snapshots the database and takes Fly snapshots of the two disks that hold data;
4. moves each app to the new release and runs the smoke test;
5. if anything fails, even the new Workspace itself, puts every app back on the release it came from and restores the database snapshot.

It keeps its record in your backup bucket (`upgrades/` in `<prefix>-backups`): what it was asked, every step, and how it ended, plus a heartbeat. If its machine is cut off, Fly starts it again and it carries on from there. Only one upgrade runs at a time.

- `--drill` rehearses the rollback on purpose and proves the database came back.
- `--drill backend` makes the new Workspace not start, and proves the way back works without it.
- `--here` runs the upgrade on this computer instead, as installers before 5 November 2026 did. The command does that by itself, once, for a copy whose running release predates the upgrader, and says so.

The health page (the workplace page's "This copy" section, for admins) says on its Workspace line which release runs and which is the latest: "Up to date" in green, "Newer release" in amber with this command to run, "Can't tell" when the update service has not been reached lately. Its "What's new" link opens every release newer than yours, newest first, each with its notes in plain words (what is new, what is fixed, and anything you must do after the upgrade), then what your own release brought. The notes come from the update service: `GET https://acc-updates.fly.dev/releases/<version>/notes.md`.

## What it creates in your organization

| What | Names |
| --- | --- |
| Four apps: the image registry, the backend (the Workspace and its database), the code host, and the router for previews and sites | `<prefix>-images`, `-backend`, `-git`, `-router` |
| Two buckets: files, and database backups | `<prefix>-media`, `<prefix>-backups` |
| The upgrader's app, made by the Workspace when it starts: no address, no disk, a machine only while an upgrade runs. Its secrets are the Workspace's own Fly token and the backup bucket's keys | `<prefix>-upgrader` |
| Two disks: the database and the code | created with the apps |
| Certificates for the domain, `git.` and `*.` | requested from Fly |

Keys are made on your machine and stored only as Fly secrets on your apps:

- an SSH key the backend uses to reach your agents' machines;
- the master key;
- shared secrets between the backend and the code host, and the one a mail receiver will present once there is one;
- the first-admin code.

It also asks Fly for a separate organization token for the backend. It writes `<prefix>-copy.json` beside itself, holding names and addresses only and never a key; the upgrade command reads it. A log of each run goes to `<prefix>-install.log` or `<prefix>-upgrade.log`.

It prints six DNS records for you to add and checks them with your domain's own name servers.

## Email, later

The install makes no mail receiver and asks for no mail provider. When you want email, an admin opens Mail in the Workspace and follows "Set up email": they give a Resend key or any provider's SMTP settings, the Workspace makes the mail receiver `<prefix>-mx` in this same organization (with the dedicated IPv4 mail needs, about $4 a month at Fly's list prices), shows the MX, A, DMARC and provider records to add, checks them, and turns mail on once they are right. A receiver an older installer made is found and kept. Until then everything else works: people's addresses are already on your domain, and the Workspace says plainly wherever something would have gone by email.

## Where it connects, and what it sends

- **Fly** (flyctl, and `api.fly.io` to read your organization's billing state): to create and deploy everything above, in your organization, with your token.
- **Our update service** (`https://acc-updates.fly.dev`): with no sign-in, only to download a release's list of images and the images themselves. It sends nothing about your own Agentic Cloud, which runs only from your own registry and never pulls from us.
- **Your domain's name servers**: to check the records you added.
- **Your own Agentic Cloud itself**: the smoke test reads the health pages of the Workspace, the code host and the router, and the sign-up page.

There is no telemetry. Once installed, your own Agentic Cloud makes one kind of call to us: about once an hour it reads the public list of releases (`GET https://acc-updates.fly.dev/releases`, no sign-in, nothing about your copy in the question) so the health page can say whether a newer release is out. To point it at another address, or to stop it, add `COPY_UPDATES_URL` (an address, or `off`) to `extraEnv.backend` in `<prefix>-copy.json` and run `node install.mjs upgrade`.

## Tests

```sh
npm test    # node --test test/*.test.mjs
```

The tests run every command against fakes of flyctl, Fly, the update service and DNS, so they create nothing anywhere.

## Licence

Apache License 2.0. See [LICENSE](LICENSE).
