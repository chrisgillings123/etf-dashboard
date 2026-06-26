name: Refresh sector P/E history

on:
  push:
    branches: [main]
    paths-ignore:
      - "public/sector-history.json"
  schedule:
    - cron: "0 18 * * 0"
  workflow_dispatch: {}

permissions:
  contents: write

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - name: Build sector history
        run: node scripts/build-sector-history.mjs
      - name: Commit if changed
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          if [ -n "$(git status --porcelain public/sector-history.json)" ]; then
            git add public/sector-history.json
            git commit -m "chore: refresh sector P/E history [skip ci]"
            git push
          else
            echo "No changes."
          fi
