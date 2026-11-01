# Set up your own Agentic Cloud

A guide for an AI agent (Claude Code, Codex or any agent with a terminal) asked by its person to set up their company's own Agentic Cloud.

Your own Agentic Cloud is the whole Agentic Cloud Computer platform (the Workspace, the agents' machines, git hosting, sites, files and email) installed in the company's own Fly.io organization, on a domain of theirs. One installer builds it. Nothing of theirs is kept by us: the only time the installer reaches us is to download a release with their update key.

It takes one command. In our clean run on 29 October 2026 it went from a new Fly organization to ready in 13 min 24 s; Fly issued the domain's certificates in under a minute that time, but one has taken over an hour before, and then you wait and run the same command again. Follow the steps in order. The page for people is https://agenticcloudcomputer.com/own-cloud.

## Rules for you

- **Change nothing until your person has agreed** to the plan (step 4). Before it come only installing flyctl, with their yes (step 1), and their own sign-in to Fly (step 2).
- **Stop and ask your person** wherever this guide says ASK YOUR PERSON, and whenever the installer ends with exit code 3 ("a person is needed"). Those answers are theirs, not yours: never guess one, and never pick a Fly organization, a domain or a payment yourself.
- **Never show or store a secret.** The Fly token, the update key, the licence, the master key and the first-admin link stay out of your replies, out of commits and out of any file you write. Pass files by path and the token through the environment. With `--json`, the installer itself keeps every key off its output.
- **Running it again is safe.** The installer writes every finished step to `<prefix>-copy.json` and carries on from the first unfinished one, making nothing twice.
- **Waiting is not failing.** Exit code 4 means Fly, Let's Encrypt or the mail provider is still working. Nobody needs to do anything: run the same command again later, and do not start over.
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
3. **The update key and the licence** from us, as two files, `update.key` and `licence.txt`, both issued for that domain. In the free first month the licence is a one-month one. If they do not have them yet, they write to adam@agenticcloudcomputer.com with the company's name and the domain, and you can still show them the plan first (step 4). Only if their agreement says it has no licence: `--no-licence` in place of `--licence-file`.
4. **How mail goes out:** any provider over standard SMTP (host, port 465 or 587, user, and a file holding the password), a Resend key file, or neither for now. It can be added later.
5. **Who adds the DNS records:** your person, or you, if you can edit the domain's DNS and they want you to.
6. **The prefix and the region,** if they care. The prefix (`--name`, the customer id in the key by default; lowercase letters, digits and hyphens, starting with a letter) becomes public app names on Fly. The region is the Fly region nearest to this computer by default, which may not be nearest to their people (`--region <code>`).

## 4. Get the installer, and show your person the plan

Download the installer this guide is written for into an empty folder. The guide names one exact file, so the commands below always match it:

```
curl -fsSL -H 'Accept: application/vnd.github.raw' -o install.mjs https://api.github.com/repos/adambaialiev/private-copy-installer/git/blobs/7e8c3555906b2c6ac3687bf749016505d68d13c2
```

Check that it is that file: `shasum -a 256 install.mjs` (`sha256sum install.mjs` on Linux, `Get-FileHash install.mjs` in PowerShell) must print `ad232092c33ff97b4ecbcdd0919d78ffc69fce6a05a9d36021aa1a78ac10ef64`. If it does not, stop and tell your person. Do not take a newer `install.mjs` from the repository's main branch instead: this guide is written for this one.

It is one file of plain JavaScript with no packages. Its code and tests are public at https://github.com/adambaialiev/private-copy-installer, so you and your person can read every line first.

Ask your person to put `update.key` and `licence.txt` beside `install.mjs`. Never paste what is in them.

Then run the plan. It changes nothing, costs nothing and writes no file:

```
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --plan --json
```

Add the mail flags, `--name` and `--region` here too, if your person gave them (see step 5).

- **Exit 0:** the plan is ready. Its result lists `creates[]` (every app, disk, bucket, address, certificate, token and secret it will make, each with Fly's list price), `monthlyUsd` (the total) and `records[]` (the DNS records it will ask for). Show your person all three, in plain words, and **wait for their yes**. Point out two things: the Workspace keeps a Fly organization token so it can start agent machines (revoking it stops that), and the prices are Fly's list prices, billed by Fly to their organization.
- **Exit 3:** a person is needed first. The result's `reason` and `person[]` say what (see the table at the end). Ask your person, then run the plan again.

**No update key and licence yet?** Run the plan without them. Give it `--name <prefix>`, because the prefix otherwise comes from the key: the one your person chose, or a short form of the company's name they agree to. Use the same `--name` when you install.

```
node install.mjs install --org <org> --domain <domain> --name <prefix> --plan --json
```

It makes every other check (Node, flyctl and the sign-in, the organization and its bill, the domain) and still lists `creates[]`, `monthlyUsd` and `records[]`, then ends with exit 3 and `"reason": "update-key"`. Show your person the plan as above, and ask about anything else `person[]` names. Then tell them how to get the two files: they write to adam@agenticcloudcomputer.com with the company's name and the domain. Stop there. When the files are beside `install.mjs`, run the full plan above and wait for their yes.

## 5. Install

With your person's yes, run the same command with `--json --wait 0` in place of `--plan --json`:

```
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --json --wait 0
```

Add one way to send mail, if your person gave one:

- SMTP: `--smtp-host <host> --smtp-port 465 --smtp-user <user> --smtp-password-file <file>` (465 or 587; 587 if you leave the port out)
- Resend: `--resend-key-file <file>`

Every line on stdout is one JSON object, and the last one is always `{"event": "result", ...}`; the readable lines go to stderr. It builds everything: the apps, the release copied into their own registry (about 1.4 GB, most of the time), the buckets, the keys, the deploys and the certificate requests. Then it stops with **exit code 3 and `"reason": "dns"`**, listing every record in `records[]` (name, type, value, priority).

If your session might end before it finishes, run it where it outlives you (tmux, for example). Nothing is lost if it stops: run the same command again.

## 6. DNS: ASK YOUR PERSON (unless you can edit it)

- Give your person the records exactly as listed, all DNS only (not proxied), and ask them to add them. If you can edit their DNS and they want you to, add them yourself, exactly as listed.
- With SMTP, they also add the SPF and DKIM records their mail provider gives them. Only that provider knows them, so the installer does not wait for them; without them, mail out lands in spam.
- Then check, without changing anything:

  ```
  node install.mjs status --json
  ```

  Exit 3 with `"reason": "dns"` means records are still missing (the result says which). Exit 4 means the records are in and the certificates are on their way. Exit 0 means everything is in. On 4 or 0, go on. Check every few minutes, not in a tight loop.

## 7. Finish

Run the install command again, this time with `--json --wait 20`:

```
node install.mjs install --org <org> --domain <domain> --key-file update.key --licence-file licence.txt --json --wait 20
```

- **Exit 0:** done. The last step is a smoke test of the Workspace, the sign-up page, the code host, a preview name and mail on port 25; the result names `handoverFile`.
- **Exit 4:** a certificate is still coming. Fly can take over an hour: in one real install the code host's certificate did. Run the same command again later.
- **Exit 1:** it failed, and `message` says why. Show your person that message, fix what it names, and run the same command again.

## 8. Hand over

The result names `<prefix>-handover.txt` (readable by this user alone). It holds the first admin's one-time link and the master key. **Do not read it out, copy it or open it yourself.** Tell your person to:

1. open the file, and keep the master key in it offline, now. Without it, a database restored into a new install cannot open the keys people saved in it;
2. open the first-admin link in a **new** browser tab and make the first account, which becomes the admin. It works once, and only while there is no account; everyone after them joins through an invite link, and an admin approves each person;
3. delete the file.

Keep `<prefix>-copy.json` in this folder, and ask your person to keep a copy somewhere safe: the upgrade reads it, and once the install is done it holds names and addresses only, no keys.

## Later: upgrades

In the same folder:

```
node install.mjs upgrade --key-file update.key --json
```

It takes the latest release the key covers (`--release <version>` picks one), snapshots the database and the disks, rolls the four apps one at a time and runs the smoke test again. If anything fails, it puts the old release back on all four and the database back as it was. `--drill` rehearses exactly that: it upgrades, fails on purpose and comes back.

## Exit codes, and when to ask your person

| Code | Meaning | What you do |
| --- | --- | --- |
| `0` | Done. | Go on to the next step. |
| `1` | It failed; `message` says why. | Show your person the message; fix what it names; run again. |
| `2` | The command was wrong. | Check the flags against this guide. |
| `3` | A person is needed; `reason` says for what. | ASK YOUR PERSON (below), then run again. |
| `4` | Still waiting on Fly, Let's Encrypt or the mail provider. | Nothing; run the same command again later. |

The reasons behind exit code 3:

- `update-key` or `licence`: the files from us are missing, or were issued for another domain. They come from adam@agenticcloudcomputer.com.
- `domain`: the domain is missing or not a name it can use.
- `fly-organization`: which organization to use. Without `--org`, the plan lists the ones the sign-in reaches.
- `fly-sign-in`: flyctl is not signed in. Your person signs in (step 2).
- `billing`: the organization has no card or an unpaid bill. The result's `billingUrl` is where they fix it.
- `mail-key`: the mail provider's key is missing or refused. Mail out is optional.
- `dns`: the records are not all in yet. The result lists them.

## What it costs

The first month is a free trial. After that your own Agentic Cloud needs a licence from us, which covers upgrades and support. Fly bills the company's account directly for the machines and disks: the plan shows Fly's list prices, and on our own test install that came to about $0.86 a day while it stood, plus about $0.09 an hour for each agent while it is awake. The agents use the company's own Claude or ChatGPT plans.
