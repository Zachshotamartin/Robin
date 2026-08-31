# Captured manifests

Do not add hand-written, placeholder, or edited acceptance manifests here.

`r0.json` is generated only by `npm run evidence:capture:r0` from a clean tested
commit. Its internal `commit` names that tested source commit; if the generated
file is added in a later commit, the container commit is not the tested commit.
Validate a captured file before attaching or tracking it:

```console
npm run evidence:validate -- --manifest evidence/manifests/r0.json
```

The generator does not upload the file.
