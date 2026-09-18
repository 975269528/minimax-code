---
name: deploy-website
description:
  Publish the first release of an existing local website project or standalone local `.html` or
  `.htm` file to a public URL. Use when a user asks to deploy or launch a local website, static
  site, frontend project, or asks to deploy an absolute HTML file path; use edit-deployed-website to
  edit an already deployed website.
descriptions:
  zh-Hans: '支持静态网站部署，适合前端网站分享、作品展示和快速发布。'
  en: 'Deploy static websites — ideal for sharing frontend sites, showcasing work, and publishing quickly.'
displayNames:
  zh-Hans: '网站部署'
  en: 'Deploy Website'
---

# Deploy Website

1. Resolve the requested target without rewriting its native path syntax. If the user supplied an
   HTML path, require a regular `.html` or `.htm` file; reject a missing file, directory, symlink,
   or control characters. Never pass a path outside the current workspace to `website_deploy`.
2. Locate the project source root. Reuse its lockfile and existing package manager. Discover its
   real build command and built-site output from the project configuration; do not add dependencies
   or invent a build. If a real build exists, run it and verify the output has a regular
   `index.html` at its root.
3. For a standalone site with no project build, first check whether its source directory is already
   a self-contained public static directory with a regular root `index.html` and locally resolving
   dependencies. If so, verify it and use that directory directly. Otherwise, for a standalone HTML
   file or a page whose dependencies need rewriting, prepare a new staging directory inside the
   current workspace without modifying the source. Never pass an HTML file itself as `path`. If the
   selected file is outside the workspace, first create a separate source snapshot inside the
   workspace containing only the selected source and required assets; stop if the source cannot be
   accessed or its dependencies cannot be copied safely. Create a regular `index.html` at the
   deployment staging root and copy only the static files required by the requested page. Preserve
   or safely rewrite relative URLs, root-relative assets, `<base>` URLs, CSS `url()` references,
   JavaScript imports, and fetch targets, then verify the staged page. Stop and explain the
   unresolved dependency instead of publishing a broken page or copying an entire source tree that
   may contain private files. Do not use symlinks, `/tmp`, or Unix-only path logic; keep Windows
   drive and UNC paths in their native form.
4. Use the verified build or deployment staging directory as `path`. Use the original project/source
   root as `source_path` only when it is inside the workspace; otherwise use the isolated source
   snapshot. A source directory that is already a self-contained public static site, with a regular
   root `index.html`, may use that same directory for both `path` and `source_path`; the runtime
   still uploads separate public and private archives. A standalone HTML file or a page whose
   dependencies need rewriting must use the distinct staging directory from step 3. A framework
   project must still use its actual build output for `path` and its source root for `source_path`.
   `path` must have a regular `index.html` at its root. Choose a short human-readable
   `project_name`.
5. Before publishing, state that the website will be publicly accessible and `source_path` will be
   uploaded to private cloud storage. There is currently no secrets scanner: ask the user to confirm
   `source_path` contains no secrets, then obtain explicit publication confirmation.
6. Call the existing `website_deploy({ path, source_path, project_name })` tool. Do not create a zip
   or upload with HTTP, OSS, or another tool.
7. Follow the existing `website_deploy` delivery format using only the tool-returned URL and
   `node_id`. Never guess or hand-write `cover`; let Runtime's trusted projection control final
   `node_id`/`cover`. Surface a tool failure as returned.
