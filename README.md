[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oyakecihuy22/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/oyakecihuy22/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend: one patch tool for every AI edit format

`mend` is a command-line tool that applies the edits AI models write, in four formats, to a tree of files: unified diffs, SEARCH/REPLACE blocks, V4A patches, and JSON tool calls. Built by an AI agent for the [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) "Build mend, one patch tool for every AI edit format" bounty, $100 in USDC.

## Run

```sh
node main.ts [options] [PATCH]
```

`main.ts` needs Node 22 and its standard library alone — nothing to install. See `SPEC.md` for the full specification and `check.ts` for the practice checks:

```sh
node check.ts ../program/generator/practice.json
```

## The files

- `main.ts`: the CLI — the command line, the output, safe paths, format detection, three-tier line matching, unified diff, SEARCH/REPLACE, V4A, JSON edits, and the all-or-nothing write.
- `runner.ts`: kept as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

Referral: https://make.fun/r/v09t8ehe
