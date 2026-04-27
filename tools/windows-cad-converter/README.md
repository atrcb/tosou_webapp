# Windows CAD Converter Worker

This worker runs on the Windows laptop and exposes the local converter at
`http://127.0.0.1:8732`. Cloudflare Tunnel publishes that local service to the
Raspberry Pi backend without router port forwarding.

## Install on the Windows laptop

1. Install 64-bit SOLIDWORKS eDrawings.
2. Install Blender and note the path to `blender.exe`.
3. Install this repo's Node dependencies:

```powershell
npm install
```

4. Build the eDrawings STL exporter:

```powershell
powershell -ExecutionPolicy Bypass -File tools\windows-cad-converter\build-edrawings-exporter.ps1
```

5. Set worker environment variables:

```powershell
setx WINDOWS_CONVERTER_TOKEN "replace-with-a-long-random-token"
setx BLENDER_EXE "C:\Program Files\Blender Foundation\Blender 4.3\blender.exe"
```

Open a new PowerShell window after `setx`.

## Run locally

```powershell
npm run cad:windows-worker
```

Health check:

```powershell
curl.exe http://127.0.0.1:8732/health
```

Conversion test:

```powershell
curl.exe -H "Authorization: Bearer $env:WINDOWS_CONVERTER_TOKEN" -F "rootName=part.sldprt" -F "files=@C:\path\to\part.sldprt" http://127.0.0.1:8732/convert --output part.glb
```

For `SLDASM`, upload the assembly and its referenced part files in the same
request.

## Cloudflare Tunnel

Create a tunnel that maps your public hostname to the local worker:

```yaml
tunnel: cad-converter
credentials-file: C:\Users\YOUR_USER\.cloudflared\cad-converter.json

ingress:
  - hostname: cad-converter.your-domain.example
    service: http://127.0.0.1:8732
  - service: http_status:404
```

Install the tunnel as a Windows service after Cloudflare has authenticated and
created the tunnel:

```powershell
cloudflared service install
cloudflared tunnel run cad-converter
```

Keep the worker and the tunnel running during the production day. The worker
binds to `127.0.0.1`, so Cloudflare Tunnel is the only public path.

## Raspberry Pi backend environment

Set these in `/home/atrcb/notion_backend/.env`, or in the service file that
starts the Raspberry Pi backend:

```text
MODEL_CONVERTER_COMMAND=node scripts/convert-via-windows-service.mjs --input {input} --input-dir {inputDir} --output {output} --root-name {original}
MODEL_CONVERTER_TIMEOUT_MS=900000
WINDOWS_CONVERTER_URL=https://cad-converter.your-domain.example
WINDOWS_CONVERTER_TOKEN=replace-with-the-same-token
WINDOWS_CONVERTER_REQUEST_TIMEOUT_MS=840000
```

Restart the Pi backend after changing these values. The running backend process
only reads them at startup.

`EASM` and `EPRT` conversion only works when the sender allowed STL export in
the eDrawings file. Protected files return a 422 response with a clear error.
