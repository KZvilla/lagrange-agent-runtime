# Image Models

Since 2.19.0 the image a Soul asks for ([[Souls]]) is made according to the model you use: how its prompt is written,
its steps and sampler, its sizes and its workflow. Everything here is in Ajustes → Imágenes (Lagrange Desktop) and in
the `imagenes` section of the global config. Every option has a switch.

## The four cases

The refiner (a separate, Soul-blind model) picks the case from what was asked. If that case is off or cannot run now,
it is lowered to the next one; the turn says both.

| Case | What it does | Needs |
|---|---|---|
| `nueva` | an image from scratch | — |
| `variacion` | another image based on the photo | the photo |
| `retoque` | changes one part of the photo, the rest stays | the photo, the part («the hat») and third-party nodes |
| `edicion` | changes the photo with an instruction | the photo and an editing model (`comfyui.modelo_edicion`) |

The order down is `edicion` → `retoque` → `variacion` → `nueva`. It never goes up. agy only makes `nueva`: if ComfyUI
is missing the model or a node, `nueva` still goes to agy when agy is in the order.

## Profiles

A profile says how a family of models is used: the prompt rules the refiner receives, the sampling, the sizes, how the
file is loaded and which cases it can do.

| Profile | For | Loads | Prompt | Starting point |
|---|---|---|---|---|
| `sdxl` | SDXL base and derivatives | checkpoint | tags, weights, negative | 30 steps, CFG 7, `dpmpp_2m` + `karras` |
| `sdxl-rapido` | Lightning, Turbo, Hyper | checkpoint | short tags | 6 steps, CFG 1.5, `euler` + `sgm_uniform` |
| `flux` | Flux.1 in separate files | UNET + two CLIPs + VAE | plain English, no negative | 25 steps, guidance 3.5, `euler` + `simple` |
| `flux-fp8` | Flux.1 as one fp8 checkpoint | checkpoint | same as `flux` | same as `flux` |
| `flux-fill` | Flux.1 Fill (`retoque`) | UNET + two CLIPs + VAE | what goes inside the zone | 25 steps, guidance 30 |
| `flux-kontext` | Flux.1 Kontext (`edicion`) | UNET + two CLIPs + VAE | one instruction | 25 steps, guidance 2.5 |

- **Which profile a model uses:** the one you assigned (`comfyui.perfil_de`); if not, the folder where ComfyUI lists
  the file; if ComfyUI cannot be asked, its name.
- **Your own profiles** (`perfiles_propios`, up to 20) are stored whole: what you save is what is used. One with the id
  of a plugin profile replaces it; deleting it brings the plugin's back. A profile edited by hand that is not valid is
  ignored and listed in Ajustes.
- **The numbers are a starting point.** The distilled SDXL models want exactly the steps they were trained for: make a
  copy of `sdxl-rapido` with yours. For Flux schnell, copy `flux` with 4 steps.
- **Files the Flux profiles expect** in ComfyUI: `clip_l.safetensors`, `t5xxl_fp8_e4m3fn_scaled.safetensors` and
  `ae.safetensors`. Change them in a copy of the profile if yours have other names.

## Your own workflows

A workflow of your own replaces the plugin's template **for one profile and one case** (`comfyui.flujos`): `nueva`,
`variacion` or `edicion`. A `retoque` with your own workflow is not supported yet.

1. Export it from ComfyUI in **API format**, as a `.json` of 2 MB at most on this machine. Paths under `deny_paths`,
   with `..` or on the network are rejected.
2. Put the markers where the values go. Always available: `{{prompt}}`, `{{negativo}}`, `{{semilla}}`, `{{ancho}}`,
   `{{alto}}`, `{{pasos}}`, `{{cfg}}`, `{{guia}}`, `{{sampler}}`, `{{scheduler}}`, `{{fuerza}}`, `{{modelo}}`,
   `{{unet}}`, `{{clip_1}}`, `{{clip_2}}` and `{{vae}}`. With a photo, `{{foto}}`; in `edicion`, `{{instruccion}}`.
3. `nueva` needs `{{prompt}}`; `variacion` also `{{foto}}`; `edicion` needs `{{foto}}` and `{{instruccion}}` or
   `{{prompt}}`.
4. It needs a `SaveImage`. With more than one, choose which.
5. Its loader has to match the profile: `CheckpointLoaderSimple` for a checkpoint, `UNETLoader` for a UNET. Any other
   loader (a GGUF one, for example) is not checked.

A marker the case does not provide stops the request before ComfyUI sees it, and the turn names it.

**LoRA slots:** next to `foo.json`, a `foo.ficha.json` declares up to four: `{ "loras": [{ "nodo": "11" }] }`. Node
`i` has to be a `LoraLoader` or `LoraLoaderModelOnly` with `lora_name` `{{lora_i}}` and its strengths
`{{lora_i_fuerza}}`.

## LoRAs

Each one has a file, a key, the families it works with and a strength. The refiner sees the keys and adds one only
when the request asks for that look, up to four. A slot that is not used is bypassed: nothing is loaded for it. Turn
all of them off with `comfyui.loras_activos`, or each with its box.

## Inpainting by text

`retoque` finds the part by its name, repaints it and puts it back. It needs custom nodes that **you** install in
ComfyUI; until then Ajustes lists which ones are missing and the case is lowered.

| For | Custom nodes |
|---|---|
| Mask with Florence-2 (`comfyui.mascara: "florence2"`, the default) | [ComfyUI-Florence2](https://github.com/kijai/ComfyUI-Florence2) |
| Mask with GroundingDINO + SAM 2 (`"sam2"`) | [ComfyUI-SAM2](https://github.com/neverbiasu/ComfyUI-SAM2) |
| Crop and stitch, with either | [ComfyUI-Inpaint-CropAndStitch](https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch) |

- Florence-2 needs its model (`microsoft/Florence-2-large`) in `ComfyUI\models\LLM\Florence-2-large`. The node tries to
  download it on the first run; with a recent `huggingface_hub`, get it yourself: `hf download
  microsoft/Florence-2-large --exclude pytorch_model.bin --local-dir <that folder>` (1.5 GB).
- ComfyUI-SAM2 asks for `numpy<2`, which does not exist for Python 3.13: on a recent ComfyUI portable, its
  requirements can break the installation. Prefer Florence-2 there.
- **Strength:** inpainting has its own (`fuerzaRetoque`, 0.9): with the 0.6 of a variation the part barely changes.
- `comfyui.retoque` is `crop-stitch` (your main SDXL model), `fill` (Flux.1 Fill, in `comfyui.modelo_retoque`) or `no`.
- **The zone check:** the mask comes back at 256×256. If it marks less than 0.05 % of the photo, or more than 98 %, the
  image is not used and the turn says why. Florence-2 always marks something, even when the part is not in the photo, so
  for it the check only catches an empty or full mask; the refiner is told to choose inpainting only if the photo shows
  the part. Retrying then makes a variation. It turns off with
  `comfyui.chequeo_zona: false`.

## Recognising an image that came back through Telegram

Telegram recompresses photos, so the file you resend is not the one the bot made. After sending one, the bot downloads
what Telegram stored and keeps its `sha256`; resending that photo to the bot is then recognised as its own. It needs
`reconocer_propias` and turns off with `reconocer_telegram: false`. A photo saved to the gallery and uploaded again may
be recompressed once more and is not recognised.

## Where each rule comes from

| What | Source |
|---|---|
| SDXL: sizes, what the text encoders read | [model card](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0), [diffusers guide](https://huggingface.co/docs/diffusers/main/en/using-diffusers/sdxl) |
| SDXL sampler: `dpmpp_2m` + `karras`, CFG 5–9 | community consensus, not an official figure; Comfy's own example uses `euler` + `normal` |
| Lightning: `euler` + `sgm_uniform`, steps of the file, no CFG | [ByteDance/SDXL-Lightning](https://huggingface.co/ByteDance/SDXL-Lightning). The profile starts at CFG 1.5 because most merges want 1 to 2 |
| Turbo: 1 to 4 steps, no CFG, no negative | [stabilityai/sdxl-turbo](https://huggingface.co/stabilityai/sdxl-turbo) |
| Flux.1 dev: guidance 3.5, CFG 1, `euler` + `simple` | [Comfy docs](https://docs.comfy.org/tutorials/flux/flux-1-text-to-image), [diffusers](https://huggingface.co/docs/diffusers/main/en/api/pipelines/flux) |
| Flux.1 Fill: guidance 30, `InpaintModelConditioning` + `DifferentialDiffusion` | [Comfy docs](https://docs.comfy.org/tutorials/flux/flux-1-fill-dev) and its template |
| Flux.1 Kontext: guidance 2.5, `ReferenceLatent`; how to write the instruction | [Comfy docs](https://docs.comfy.org/tutorials/flux/flux-1-kontext-dev), [BFL prompt reference](https://docs.bfl.ml/guides/prompting_unified_reference) |
| No negative prompt in Flux: describe what is there | [BFL technical parameters](https://docs.bfl.ml/guides/prompting_unified_technical) |
