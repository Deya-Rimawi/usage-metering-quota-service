# Demo client

A small "document processing" app that calls the metering service **on behalf of its users**, using one account's API key. The document processing is simulated; the metering calls are real.

## Run it
```bash
cp .env.example .env            # once
docker compose up --build       # db + service + client
```
| URL | What |
|---|---|
| http://localhost:8080 | The demo client (open this one) |
| http://localhost:3000/docs | The metering service's API docs |

On start the client creates a demo account and two users:
| Who | Plan | Limits |
|---|---|---|
| Account | custom "Demo Account" | 100 units/month, 40 per request |
| alice | predefined **Basic** | 500/month, 20 per request |
| bob | predefined **Premium** | 5,000/month, 200 per request |

The account's small allowance is deliberate: it is easy to hit the *shared* limit while a user still has plenty.

## Click through it
1. **Run scenario** runs the whole story and ticks off each expectation:
   1. alice processes 10 units: accepted
   2. alice tries 25: rejected by her **user** per-request limit (Basic allows 20)
   3. bob processes 40, then 40 again: accepted (account used 90 of 100)
   4. bob asks for 20: rejected by the **account** monthly allowance (10 left) although bob has thousands left
   5. *Configure:* raise the account allowance to 500 (`PATCH /plans/{id}`), then bob's request is accepted
   6. *Configure:* switch alice to Premium (`PUT /users/alice/plan`), then her 25-unit request is accepted
   7. Retrying an old request id returns the stored answer (`replayed`) and counts nothing twice
2. Or do it by hand: pick a user, enter pages, **Process**. **Retry last request** resends the same `requestId`. Use the "Change the rules" panel to switch a user's plan or edit the account limits and process again.

## Why this shows "no client code change"
The only metering call in the business path is `consume()` ([`client/metering-client.mjs`](../client/metering-client.mjs)). Changing limits goes through *configuration* endpoints; `consume()` and the code around it are identical before and after, yet the same request gets a different answer.

## Reading the code
| File | Role |
|---|---|
| `client/metering-client.mjs` | The integration pattern: a ~50-line wrapper over the HTTP API |
| `client/demo.mjs` | Demo data + the scripted scenario (each step declares what it expects) |
| `client/server.mjs` | Tiny server for the page; holds the API key so browsers never see it |
| `client/public/index.html` | The page (plain HTML/JS, light and dark theme) |
| `client/test/scenario.test.mjs` | End-to-end test of the scenario |

## Test it
```bash
docker compose up -d --build
docker compose --profile tools run --rm e2e     # runs the scenario against the live stack and asserts every step
```
