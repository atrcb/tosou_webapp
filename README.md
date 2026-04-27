<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/e8862ac1-8e47-4d8c-9069-a27897c27609

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Notion Embed Notes

- Use a public `https://` URL for `EMBED_BASE_URL` when generating Notion embed links.
- Do not generate embed links from `http://localhost:3001`. Those links only work on the same machine that is running the server.
- `/embed-app` links are now persistent by default so the same Notion block can keep working across desktop and iOS.
- If the embed already exists in Notion and was created from a local URL or an older short-lived token, generate a fresh embed link and replace the Notion block. Notion will keep using the old URL until you update it.
- iPad Notion now receives a lightweight compatibility embed page that avoids the full React bundle, uses the standard file picker, and provides a manual result download.

## CAD Conversion Notes

- STEP/STP files are parsed directly in the browser viewer.
- SLDPRT, SLDASM, EASM, and EPRT uploads require the Raspberry Pi backend to call the Windows laptop converter through Cloudflare Tunnel.
- Configure the Pi backend with `MODEL_CONVERTER_COMMAND`, `WINDOWS_CONVERTER_URL`, and `WINDOWS_CONVERTER_TOKEN`; see [tools/windows-cad-converter/README.md](tools/windows-cad-converter/README.md).
- The Windows laptop must keep `npm run cad:windows-worker` and `cloudflared` running during production hours.
