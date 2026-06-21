# ImageOPS PRO Lab

Brand: `ImageOPS`

Product: `ImageOPS PRO Lab`

Node.js + TypeScript app for prompt/image-to-image generation with OpenAI Image API, Rob-Token credits, PayPal checkout, 1080p test renders, 4K max renders, and optional local `localRTXup` 4K-to-8K post-processing.

## Flow

1. User logs in or registers.
2. User sends prompt plus optional reference images.
3. Server charges Rob-Token credits and creates either a 1080p test PNG or a 4K max PNG through OpenAI.
4. Server creates a matching high-quality JPG download from the PNG.
5. User reviews/downloads the 1080p or 4K PNG/JPG in the frontend.
6. Optional: user promotes a 1080p test render into a new 4K max render.
7. Optional: user clicks `RTX 8K`; the server copies the finished 4K max render to the configured localRTXup input file, runs the configured PowerShell command, then copies the configured output file back into the web gallery.
8. Server also creates an 8K JPG, so the final output has separate `8K PNG` and `8K JPG` download buttons.

Credit formula:

```text
Test render 1080p = 3 Rob-Token
Max render 4K = 15 Rob-Token
local RTX 8K upscale = +5 Rob-Token
1080p test plus later 4K max render = 18 Rob-Token total
4K render plus 8K output = 20 Rob-Token total
1080p test plus 4K max plus 8K output = 23 Rob-Token total
```

RTX 8K is only available after a 4K Max render. 1080p test renders are too small for the local RTX-up stage, but they can be promoted into a new 4K Max render from the frontend.

Credits are charged at job start. Failed OpenAI renders, failed 4K promotions, and failed local RTX-up runs do not automatically refund credits.

OpenAI render background can be selected per job:

```text
Opaque
Transparent
```

The browser never writes to random desktop folders. The local Node server performs the SDK file transfer.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`:

```env
DATA_BACKEND=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-server-only
OPENAI_API_KEY=sk-your-key
JWT_SECRET=replace-with-a-long-random-secret
PAYPAL_CLIENT_ID=your-paypal-client-id
PAYPAL_CLIENT_SECRET=your-paypal-client-secret
```

Run in development:

```powershell
npm run dev
```

Frontend: `http://127.0.0.1:5173`

Backend: `http://127.0.0.1:8080`

## Test User

After Supabase is configured, create a test user in Supabase:

```powershell
npm run seed:test-user
```

Login:

```text
E-Mail: test@imageops.local
Passwort: Test123456!
```

The script grants at least `500` Rob-Token credits. It uses the active `DATA_BACKEND`; with the default config, this writes to Supabase.

## Supabase Database

Supabase replaces the JSON file as the normal database for users, credits, PayPal orders, and render history.

1. Create a Supabase project.
2. Open the Supabase SQL editor.
3. Run [supabase/schema.sql](./supabase/schema.sql).
4. Set `.env`:

```env
DATA_BACKEND=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-server-only
```

Keep `SUPABASE_SERVICE_ROLE_KEY` server-side only. The frontend never receives it.

Tables created:

```text
app_users       login users, password hashes, Rob-Token credits
image_jobs      prompt/render jobs, 4K/8K output URLs, costs
paypal_orders   PayPal order IDs, package IDs, capture status, credited amount
```

The app still uses its own email/password login and JWT sessions. Supabase is used as the persistent Postgres database.

If your Supabase tables already exist from an older version, add the background column manually:

```sql
alter table public.image_jobs
  add column if not exists background text check (background in ('opaque', 'transparent'));
```

For isolated offline testing only, you can switch back to the local JSON store:

```env
DATA_BACKEND=local
```

## PayPal Toggle

PayPal can stay disabled while the store UI remains visible and greyed out:

```env
PAYPAL_ENABLED=false
```

To activate PayPal later:

```env
PAYPAL_ENABLED=true
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=your-paypal-client-id
PAYPAL_CLIENT_SECRET=your-paypal-client-secret
PAYPAL_CURRENCY=EUR
```

The PayPal server code and frontend checkout are still present; the toggle only disables the live checkout.

## localRTXup SDK

Create the expected SDK wrapper folder:

```powershell
npm run rtx:local:init -- C:\localRTXup
```

If you already have a folder with local RTX upscaler files, pass that folder instead. Existing `run.ps1` and `readme.txt` files are left untouched; missing `input` and `output` folders are created.

You can also do this from the frontend after login. In the studio, use `SDK Setup`, enter a folder such as `C:\localRTXup`, and click `Wrapper erstellen`. The frontend calls the local Node server; the browser itself does not execute PowerShell or write arbitrary folders.

The project already includes an initialized `localRTXup` folder. The command creates this structure if it is missing:

```text
C:\localRTXup\
  input\
    4k.png
  output\
    8k.png
  readme.txt
  run.ps1
```

Open `C:\localRTXup\readme.txt` and `C:\localRTXup\run.ps1`. Replace the placeholder in `run.ps1` with the command from your actual local RTX upscaler. The contract is fixed:

```text
input\4k.png  ->  output\8k.png
```

For your SwinIR folder, use custom file names:

```env
LOCAL_RTXUP_DIR=C:\Users\lrt71\Desktop\Desktop\Developer\localRTXup\my_upscaler
LOCAL_RTXUP_COMMAND=.\run.ps1
LOCAL_RTXUP_INPUT_FILE=input\input.png
LOCAL_RTXUP_OUTPUT_FILE=output\out8k.png
```

Recommended `run.ps1` for your command:

```powershell
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

conda run -n swinir python "$root\up_swinir_12k_to_8k.py" `
  --in "$root\input\input.png" `
  --model "$root\model_x3.pth" `
  --out8k "$root\output\out8k.png" `
  --tile 1024 `
  --overlap 64
```

This is more reliable from Node than `conda activate swinir`, because it does not depend on an interactive shell profile.

Then set `.env`:

```env
RTX_UPSCALER_ENABLED=true
RTX_UPSCALER_MODE=localRTXup
LOCAL_RTXUP_DIR=C:\localRTXup
LOCAL_RTXUP_COMMAND=.\run.ps1
LOCAL_RTXUP_INPUT_FILE=input\4k.png
LOCAL_RTXUP_OUTPUT_FILE=output\8k.png
LOCAL_RTXUP_POWERSHELL=powershell.exe
```

Restart `npm run dev`. In the studio, generate a 4K max image first, then click `RTX 8K`.

The SDK handoff is automatic:

```text
ImageOPS PRO Lab 4K PNG -> LOCAL_RTXUP_INPUT_FILE
localRTXup PowerShell run -> LOCAL_RTXUP_OUTPUT_FILE
ImageOPS PRO Lab final downloads -> storage\generated\*-8k.png and *-8k.jpg
```

## Optional NVIDIA SDK Source Download

If you want NVIDIA Image Scaling source material locally:

```powershell
npm run rtx:sdk:download
```

This downloads the NVIDIA Image Scaling repository into `vendor/NVIDIAImageScaling`. It is SDK/source material, not a finished Node package. Build or wrap your local upscaler so `run.ps1` can read `LOCAL_RTXUP_INPUT_FILE` and write `LOCAL_RTXUP_OUTPUT_FILE`.

## Production Notes

Supabase is the intended database. Before exposing this publicly, add email verification, PayPal webhook verification, and harden rate limits and audit logging.
