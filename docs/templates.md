# Venue Templates

PaperOrchestra treats a **venue** and a **template edition** as separate
objects. A venue such as CVPR is stable; its annual author kit is not. Always
select an explicit edition (`cvpr2026`, never `cvpr`) so an existing workspace
cannot silently change its formatting contract.

## Inspect the catalog

```bash
paper-orchestra templates list
paper-orchestra templates list --ccf-a
paper-orchestra templates info cvpr2026
paper-orchestra templates info fast
```

The catalog records all 58 conferences in the CCF seventh-edition A list. It
does not claim that a publisher-wide ACM, IEEE, USENIX, Springer, or SIAM class
is an interchangeable author kit: obtain the exact kit linked by the target
conference's current CFP. Each identity records an authoring source and the
date it was checked. `usenix-atc` remains present for its final 2025 edition;
it does not imply that an ATC 2026 template exists.

## Official-download adapters

CVPR 2026 and ICLR 2026 are checksum-pinned download adapters. Their source
files are not redistributed in this repository because the upstream projects do
not declare a repository-level redistribution license.

```bash
paper-orchestra templates install cvpr2026 ./templates/cvpr2026
paper-orchestra write --template ./templates/cvpr2026 --allow-lkm-spend

paper-orchestra templates install iclr2026 ./templates/iclr2026
paper-orchestra write --template ./templates/iclr2026 --allow-lkm-spend
```

The installer downloads directly from the official source, verifies SHA-256,
rejects unsafe archives, preserves the upstream support files, and creates the
stable `template.tex` entry point plus provenance metadata. It does not edit
the upstream style files.

## Manually downloaded CCF-A kits

For an edition whose kit must be downloaded from the conference website, use an
explicit CCF-A key and a four-digit year. The local adapter ID must match the
key and year, so `fast2026` cannot accidentally become an unversioned `fast`.

```bash
paper-orchestra templates adapt fast2026 /path/to/official-fast-kit ./templates/fast2026 \
  --venue fast --year 2026 --entry main.tex --source-url <official-fast-cfp-or-kit-url>
paper-orchestra write --template ./templates/fast2026 --allow-lkm-spend
```

`--entry` names the official kit's main `.tex` file; `--source-url` records the
exact official CFP or kit URL that supplied it. The command preserves
nested support files and writes `template-metadata.json` and `guidelines.md`
alongside the unmodified author kit. Read `paper-orchestra templates info fast`
for the conference's authoring resource.

## Natural sciences and mathematics

- `nature-portfolio` is a bundled, project-authored scaffold. It is explicitly
  **not** an official Nature template; select the target journal and follow its
  author instructions before submission. Its per-journal submission manifests
  cover Nature, Nature Communications, and Scientific Reports in
  [`templates/nature-portfolio/journals.json`](../templates/nature-portfolio/journals.json).
- `science-family` is a manual adapter. Download the selected AAAS journal's
  official kit and use its license terms; the repository does not redistribute
  it. Its six journal instruction links and source-license status are recorded
  in [`templates/science-family/manifest.json`](../templates/science-family/manifest.json).

  ```bash
  paper-orchestra templates adapt science-family /path/to/aaas-kit ./templates/science-family \
    --entry <main.tex> --source-url <official-aaas-kit-url>
  ```
- `siam-proceedings`, `isit2026`, `colt2026`, and `aistats2026` are documented
  mathematics adapters. `isit<year>`, `colt<year>`, and `aistats<year>` are
  also recognized as manual, immutable edition adapters, for example:

  ```bash
  paper-orchestra templates adapt isit2027 /path/to/official-isit-kit ./templates/isit2027 \
    --entry <main.tex> --source-url <official-isit-cfp-or-kit-url>
  ```

  Their target event/journal decides the current kit. ICM is deliberately not
  represented as a generic yearly submission template because it is an
  invited-proceedings path.

Every bundled template has a provenance manifest and is smoke-compiled in the
test suite. The repository also contains a networked verifier for the two
checksum-pinned official adapters:

```bash
npm run test:official-templates
```

Run it only with network access. It downloads the official kits into a
temporary directory and leaves no third-party author-kit files in the checkout.
