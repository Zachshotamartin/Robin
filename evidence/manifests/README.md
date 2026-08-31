# Captured manifests

Do not add hand-written, placeholder, or edited acceptance manifests here.

`r0.json` and `r1.json` are generated only by their matching
`npm run evidence:capture:<gate>` command from a clean tested commit. A
manifest's internal `commit` names that tested source commit; if the generated
file is added in a later commit, the container commit is not the tested commit.
Validate a captured file before attaching or tracking it:

```console
npm run evidence:validate -- --manifest evidence/manifests/r0.json
npm run evidence:validate -- --manifest evidence/manifests/r1.json
```

The generator does not upload the file.
