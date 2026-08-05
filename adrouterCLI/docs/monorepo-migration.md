# Monorepo migration

Import this standalone repository into the future AdRouter monorepo with history and tags intact. Freeze writes, fetch all branches and tags, record the final source commit, then use a subtree or unrelated-history merge into the chosen prefix. Verify commit counts, tag targets, package provenance links, and release workflows before changing the canonical remote. Do not squash the import.
