# Set up your own Agentic Cloud

A guide for an AI agent (Claude Code, Codex or any agent with a terminal) asked by its person to set up their company's own Agentic Cloud.

Your own Agentic Cloud is the whole Agentic Cloud Computer platform (the Workspace, the agents' machines, git hosting, sites, files and email) installed in the company's own Fly.io organization, on a domain of theirs. One installer builds it. Email is not part of the install: once it is up, an admin turns it on from the Workspace whenever they want it. Nothing of theirs is kept by us: the only time the installer reaches us is to download a release, with no sign-in. It needs nothing from us: no key, no licence, no email. The product is free for now.

It takes one command. In our clean run on 29 October 2026 it went from a new Fly organization to ready in 13 min 24 s; Fly issued the domain's certificates in under a minute that time, but one has taken over an hour before, and then you wait and run the same command again. Follow the steps in order. The page for people is https://agenticcloudcomputer.com/own-cloud.

## Rules for you

- **Change nothing until your person has agreed** to the plan (step 4). Before it come only installing flyctl, with their yes (step 1), and their own sign-in to Fly (step 2).
- **Stop and ask your person** wherever this guide says ASK YOUR PERSON, and whenever the installer ends with exit code 3 ("a person is needed"). Those answers are theirs, not yours: never guess one, and never pick a Fly organization, a domain or a payment yourself.
- **Never show or store a secret.** The Fly token, the master key and the first-admin link stay out of your replies, out of commits and out of any file you write. Pass files by path and the token through the environment. With `--json`, the installer itself keeps every key off its output.
- **Running it again is safe.** The installer writes every finished step to `<prefix>-copy.json` and carries on from the first unfinished one, making nothing twice.
- **Waiting is not failing.** Exit code 4 means Fly or Let's Encrypt is still working. Nobody needs to do anything: run the same command again later, and do not start over.
- **This guide assumes you run on your person's computer,** where they can put files and open a file you point to. If you run anywhere else, agree with them first how files reach you and how they read the handover file.

## 1. Check this computer

Run these and report what is missing. Do not install anything without your person's yes.

- `node --version`: Node 20 or newer.
- `fly version`: flyctl 0.4.115 or newer. An older one cannot finish a sign-in from another device; `fly version upgrade` updates it.

If flyctl is missing, ask your person, and with their yes install it with Fly's own script (https://fly.io/docs/flyctl/install/):

- macOS or Linux: `curl -L https://fly.io/install.sh | sh` (or `brew install flyctl`)
- Windows: `pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"`

The script puts it in `~/.fly/bin`. If `fly` is still not found, call `~/.fly/bin/flyctl`; the installer looks there by itself.

## 2. Sign in to Fly: ASK YOUR PERSON

Run `fly auth whoami`. If it names the Fly user your person wants to use, go on to step 3.

If not, your person signs in themselves; never sign in with an account of your own. Start `fly auth login` so it keeps running after your command returns (in the background, or in tmux): it waits up to 15 minutes for them. It prints a sign-in link.

- **This computer has a browser your person is using:** the sign-in page opens there. They sign in and approve, and the command finishes by itself.
- **No browser here** (a server, a container, a remote session): give your person the link it printed, and wait. They open it on their own phone or computer, sign in and approve. The page then shows a one-time code: ask them for it, and run `fly auth login --code <code>`. The code works once, for this sign-in only.

Then run `fly auth whoami` again, and tell your person which Fly user you are signed in as.

Instead of signing in, your person can give you an organization token as `FLY_API_TOKEN` in your environment. Do not ask them to paste a token into the chat.

## 3. ASK YOUR PERSON

Run `fly orgs list` and show your person the organizations it lists. Then ask all of these in one message, and wait for the answers.

1. **The Fly organization.** Which of those, by its slug. It needs a card on file and its bill paid up: Fly bills it directly for everything the install runs. Nothing of ours is on that bill. If the one they want is not listed, the Fly user signed in is not a member of it: go back to step 2, and they sign in as one who is.
2. **The domain name.** A name of its own, such as `agents.yourcompany.com`, never the company's main domain: the company's mail lives there, and the sites its agents publish will share this name.
3. **Who adds the DNS records:** your person, or you, if you can edit the domain's DNS and they want you to.
4. **The prefix and the region,** if they care. The prefix (`--name`; by default it comes from the domain, so `agents.yourcompany.com` gives `agents-yourcompany`; lowercase letters, digits and hyphens, starting with a letter) becomes public app names on Fly. The region is the Fly region nearest to this computer by default, which may not be nearest to their people (`--region <code>`).

Do not ask about email. It is not part of the install: once their Agentic Cloud is up, an admin sets it up in the Workspace, under Mail, with their mail provider's details, and the Workspace makes the mail receiver and shows the records to add. Tell your person that, so nobody expects it at the end.

## 4. Get the installer, and show your person the plan

Download the installer this guide is written for into an empty folder. The guide names one exact file, so the commands below always match it:

```
curl -fsSL -o install.mjs 'https://agenticcloudcomputer.com/workspace/api/public/workplaces/acc/repos/agentic-cloud/raw/4a4f07db66498df0c7d6cff3be7beeeaddb4ba2c?path=infra/copy-installer/install.mjs'
```

Check that it is that file: `shasum -a 256 install.mjs` (`sha256sum install.mjs` on Linux, `Get-FileHash install.mjs` in PowerShell) must print `aec069572118ec47056b4304057d4529856ba51429f23d32a8a6f91a1981a72f`. If it does not, stop and tell your person. Do not take a newer `install.mjs` from the repository's main branch instead: this guide is written for this one.

It is one file of plain JavaScript with no packages. Its code and tests are public in the platform's own open-source repository, at https://agenticcloudcomputer.com/acc/agentic-cloud?path=infra/copy-installer, so you and your person can read every line first.

Then run the plan. It changes nothing, costs nothing and writes no file:

```
node install.mjs install --org <org> --domain <domain> --plan --json
```

Add `--name` and `--region` here too, if your person gave them.

- **Exit 0:** the plan is ready. Its result lists `creates[]` (every app, disk, bucket, address, certificate, token and secret it will make, each with Fly's list price), `monthlyUsd` (the total) and `records[]` (the DNS records it will ask for). Show your person all three, in plain words, and **wait for their yes**. Point out two things: the Workspace keeps a Fly organization token so it can start agent machines (revoking it stops that), and the prices are Fly's list prices, billed by Fly to their organization.
- **Exit 3:** a person is needed first. The result's `reason` and `person[]` say what (see the table at the end). Ask your person, then run the plan again.

## 5. Install

With your person's yes, run the same command with `--json --wait 0` in place of `--plan --json`:

```
node install.mjs install --org <org> --domain <domain> --json --wait 0
```

Every line on stdout is one JSON object, and the last one is always `{"event": "result", ...}`; the readable lines go to stderr. It builds everything: the apps, the release copied into their own registry (about 1.4 GB, most of the time), the buckets, the keys, the deploys and the certificate requests. Then it stops with **exit code 3 and `"reason": "dns"`**, listing every record in `records[]` (name, type, value, priority).

If your session might end before it finishes, run it where it outlives you (tmux, for example). Nothing is lost if it stops: run the same command again.

## 6. DNS: ASK YOUR PERSON (unless you can edit it)

- Give your person the records exactly as listed, all DNS only (not proxied), and ask them to add them. If you can edit their DNS and they want you to, add them yourself, exactly as listed.
- Then check, without changing anything:

  ```
  node install.mjs status --json
  ```

  Exit 3 with `"reason": "dns"` means records are still missing (the result says which). Exit 4 means the records are in and the certificates are on their way. Exit 0 means everything is in. On 4 or 0, go on. Check every few minutes, not in a tight loop.

## 7. Finish

Run the install command again, this time with `--json --wait 20`:

```
node install.mjs install --org <org> --domain <domain> --json --wait 20
```

- **Exit 0:** done. The last step is a smoke test of the Workspace, the sign-up page, the code host, and a preview name; the result names `handoverFile`.
- **Exit 4:** a certificate is still coming. Fly can take over an hour: in one real install the code host's certificate did. Run the same command again later.
- **Exit 1:** it failed, and `message` says why. Show your person that message, fix what it names, and run the same command again.

## 8. Hand over

The result names `<prefix>-handover.txt` (readable by this user alone). It holds the first admin's one-time link and the master key. **Do not read it out, copy it or open it yourself.** Tell your person to:

1. open the file, and keep the master key in it offline, now. Without it, a database restored into a new install cannot open the keys people saved in it;
2. open the first-admin link in a **new** browser tab and make the first account, which becomes the admin. It works once, and only while there is no account; everyone after them joins through an invite link, and an admin approves each person;
3. delete the file.

Tell them too that email is not set up yet: when they want it, an admin opens Mail in the Workspace and follows "Set up email". It needs their mail provider's details (a Resend key, or any provider's SMTP settings), adds about $4 a month to their Fly bill for the mail receiver, and asks for a few more DNS records.

Keep `<prefix>-copy.json` in this folder, and ask your person to keep a copy somewhere safe: the upgrade reads it, and once the install is done it holds names and addresses only, no keys.

## Later: upgrades

In the same folder:

```
node install.mjs upgrade --json
```

It takes the latest release (`--release <version>` picks one), snapshots the database and the disks, rolls the backend, the code host and the router one at a time and runs the smoke test again. If anything fails, it puts the old release back on all of them and the database back as it was. A mail receiver the Workspace made follows the new release by itself. `--drill` rehearses exactly that: it upgrades, fails on purpose and comes back.

## Exit codes, and when to ask your person

| Code | Meaning | What you do |
| --- | --- | --- |
| `0` | Done. | Go on to the next step. |
| `1` | It failed; `message` says why. | Show your person the message; fix what it names; run again. |
| `2` | The command was wrong. | Check the flags against this guide. |
| `3` | A person is needed; `reason` says for what. | ASK YOUR PERSON (below), then run again. |
| `4` | Still waiting on Fly or Let's Encrypt. | Nothing; run the same command again later. |

The reasons behind exit code 3:

- `domain`: the domain is missing or not a name it can use.
- `fly-organization`: which organization to use. Without `--org`, the plan lists the ones the sign-in reaches.
- `fly-sign-in`: flyctl is not signed in. Your person signs in (step 2).
- `billing`: the organization has no card or an unpaid bill. The result's `billingUrl` is where they fix it.
- `dns`: the records are not all in yet. The result lists them.

## What it costs

Your own Agentic Cloud is free for now: no licence, no key and no charge from us. Fly bills the company's account directly for the machines and disks: the plan shows Fly's list prices (about $17 a month before any agent), plus about $0.09 an hour for each agent while it is awake. Email, once an admin turns it on, adds about $4 a month. The agents use the company's own Claude or ChatGPT plans.
