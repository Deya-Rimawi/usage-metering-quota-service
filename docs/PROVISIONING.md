# Provisioning: who creates accounts, and who holds which secret

The brief says to "create accounts and issue an API key for each one" but not who may do that. This page records the design and how it is used in a real deployment.

## The short answer
By default only the **operator** of the metering service creates accounts, using the **admin token**. An account never receives the admin token, only its own API key. The two credentials do not overlap in either direction (tested): an account key on an admin route is `401`, and the admin token on a data route is `401`.

There is also an **optional self-service mode** (`OPEN_SIGNUP=true`, off by default) in which anyone can create an account and receives the key directly in the response, with no operator in between. See [Self-service signup](#self-service-signup-optional) below.

## Two ways to map the model onto a product
| | One account for the whole application | **One account per customer organization** |
|---|---|---|
| Account | the application itself (for example PagePilot) | each customer company (Acme Law, Bright Dental) |
| Users | all of the application's end users | that organization's employees |
| Account plan | the application's total capacity | what the customer bought (for example Pro) |
| Created | once, by the operator | **automatically by the application's signup code** |

The brief's example ("the company has a shared monthly allowance, and each user has an individual allowance") is the second row: the customer company shares one pot, and each employee has a personal limit inside it.

## The usual real-world flow (the application provisions its own customers)
```
 Customer admin         Application backend              Metering service
 (browser)              (trusted, holds secrets)          (internal network)
     |                           |                              |
 1.  |-- signs up, picks Pro --->|                              |
     |                           |-- 2. POST /accounts -------->|
     |                           |   X-Admin-Token + externalId |
     |                           |<-- {created, account, key} --|  3. key shown ONCE
     |                           | 4. stores key, encrypted,    |
     |                           |    next to the customer      |
     |<-- "Welcome!" ------------|                              |
 5.  |-- adds employee Dana ---->|-- POST /users (that key) --->|
 6.  |-- Dana uploads a PDF ---->|-- POST /consume (that key) ->|
     |                           |<-- accepted / rejected ------|
```
```ts
// inside the application's signup handler (server-side only)
const res = await fetch(`${METERING_URL}/accounts`, {
  method: 'POST',
  headers: { 'x-admin-token': process.env.METERING_ADMIN_TOKEN!, 'content-type': 'application/json' },
  body: JSON.stringify({ name: 'Acme Law', planId: 'pro', externalId: customer.id }),   // externalId = YOUR customer id
});
const out = await res.json();
if (out.created) await db.customers.update(customer.id, { meteringKey: encrypt(out.apiKey), meteringAccountId: out.account.id });
```

## Who holds what
| Secret | Held by | Can do | Cannot do |
|---|---|---|---|
| **Admin token** | The provisioning code of the operator only | Create accounts; issue a new key for an account that lost its key | Consume, or read any account's usage or users |
| **An account's API key** | The application backend, on that customer's behalf | Everything inside that one account | See any other account; create accounts |
| Neither | Customers' employees and browsers | Nothing directly (they only talk to the application) | n/a |

A leaked customer key exposes one account. A leaked admin token lets an attacker create accounts but not read anyone's data, which is why the admin endpoint belongs on an internal network in production. In this repository the demo client's *server* holds the admin token because it plays the provisioning backend; the browser page never sees it (the page contains no reference to it).

## Retries are safe: `externalId`
A provisioning call can time out after the service created the account. Without protection a retry would create a second account. So `POST /accounts` accepts an optional `externalId`, your own id for the customer, and is **get-or-create**:

| Call | Result |
|---|---|
| First call with `externalId: "cust_42"` | `201 {created: true, account, apiKey}` |
| Same `externalId` again (retry) | `200 {created: false, account, apiKey: null}`: the existing account, **no new key**, no duplicate |
| Ten simultaneous calls | Exactly one `created: true`; the unique index decides the race |
| No `externalId` | A new account every time (as before) |

Two details worth knowing:
- **The key cannot be shown twice** (only its hash is stored). If the first response was lost, the retry reports the account with `apiKey: null`, and the operator calls `POST /accounts/{id}/api-key/rotate` to get a working key. That is safe because nothing could have used the lost key.
- **Only the first call decides the other fields.** A retry with a different name or plan does not change the account; the id alone identifies it. (Plans change later through the plan endpoints, not through account creation.)

## Self-service signup (optional)
In real API products a customer signs up and gets a key without anyone handing it over. The service-side half of that flow is available behind a switch:

```bash
OPEN_SIGNUP=true docker compose up -d      # or set it in .env
curl -s -X POST localhost:3000/accounts -H 'content-type: application/json' -d '{"name":"PagePilot"}'
# 201 {"created":true,"account":{...},"apiKey":"mk_..."}     <- no admin token, key comes straight back
```
| | With the admin token (operator or provisioning backend) | Without a token (self-service, only if `OPEN_SIGNUP=true`) |
|---|---|---|
| Allowed when | always | only when the switch is on; otherwise `401` |
| `externalId` / idempotent retries | yes | **no** (`403`): it would let anyone probe which customer ids exist |
| Rate limit (per IP) | generous (`ADMIN_RATE_LIMIT_PER_MIN`, 600) | strict (`SIGNUP_RATE_LIMIT_PER_MIN`, 10) |
| Counted against a cap | no | yes (`SIGNUP_MAX_ACCOUNTS`, 10,000; exact under simultaneous requests) |
| Wrong admin token sent | `401` | `401` (never silently turned into a signup) |

Only account creation opens up. Everything else (data routes, admin key recovery) keeps its protection. The reasoning, the controls and what was left out (email verification, CAPTCHA, a signup page: the website's job, outside the brief) are in [ADR-008](decisions/ADR-008-optional-self-service-signup.md). A self-service account that loses its key can only be recovered by an operator with the admin rotate endpoint.

## What this design does not cover
- **No account deletion or deactivation.** Offboarding would switch the account to a zero-allowance plan; a `disabled` flag is the proper fix.
- **One shared admin token**, not per-operator credentials with an audit trail.
- **No network separation.** A production deployment would put `/accounts` and the rotate endpoint on an internal network or port (the data plane and the control plane are in one service here, which the brief allows).
- **No signup website, human login, email verification or CAPTCHA**, which the brief puts out of scope (the self-service switch above is the service side only).
See [LIMITATIONS.md](LIMITATIONS.md) and [SECURITY.md](SECURITY.md).
