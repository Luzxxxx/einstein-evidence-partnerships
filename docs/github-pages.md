# ProofBridge saved demo on GitHub Pages

The `gh-pages` branch is a static publication of real saved results. It contains no model key, inference backend, new Run creation or mock approvals. The previous Sites deployment is retained as a fallback.

In repository **Settings → Pages**, choose **Deploy from a branch**, then **gh-pages**, **/ (root)** and **Save**. Confirm the real published address shown by GitHub before changing the competition links. Uploading the branch alone does not enable Pages.

The project path is `/einstein-evidence-partnerships/`. The Vite build, saved GET adapter and guide use this path. `scripts/build-github-pages-demo.mjs` consumes the previously verified local static capture at `var/submission/demo-site/dist`, preserving all 545 response bodies and the approved export bytes. It does not read a model key or contact a model. Publication files are isolated from live runtime state.

The homepage follows the user's supplied visual reference: handwritten heading, four pastel cards and a black primary action. Search filters only published saved proposals; it does not run a new analysis. Kalam is self-hosted under the SIL Open Font License, included with the font and static deployment.

Validation includes the adapter/search tests, Web type checking/build, a real loopback static HTTP check, and independent read-only review. Browser rendering must be verified separately; a static build or branch upload is not substituted for it.
