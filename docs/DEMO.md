# Demo script

## Preparation

1. Create a disposable project containing a few harmless text/source files.
2. Generate a new local Router bearer and obtain a submission-only Agnes key.
3. Configure `router/.env.local` with both values.
4. Configure `adrouterCLI/.env.local` with only the matching Router bearer.
5. Start Router, confirm `GET /health/ready`, and confirm `GET /v1/models` lists four Agnes models.

## Recording sequence

1. Start AdRouterCLI in the disposable project with `agnes-2.5-flash`.
2. Ask it to inspect and summarize a harmless file, then make a small reversible edit.
3. Show normal tool activity and the separately labeled synthetic sponsor panel.
4. Show the final estimated cost and simulated subsidy settlement.
5. Run `/ads off`, repeat a comparable turn, and show that placement/subsidy disappear while Agnes
   still answers.
6. Optionally use a configured sensitive-topic fixture to show `NONE` without blocking generation.

## Spoken disclosures

- Agnes output is live and uses the operator's key.
- Sponsor inventory and subsidy are synthetic prototype fixtures.
- Sponsor data is kept outside model/tool/command/edit context.
- This demo does not prove advertiser demand, revenue, conversion, or production readiness.

Never show terminal history, `.env.local`, credentials, personal data, or a production repository.
