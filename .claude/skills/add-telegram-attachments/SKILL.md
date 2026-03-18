---
name: add-telegram-attachments
description: Add PDF and image attachment support to the Telegram channel. PDFs are saved to the group workspace and readable by the agent via pdf-reader. Images are resized and passed to the agent as multimodal content blocks. Requires the Telegram channel to be installed.
---

# Add Telegram Attachments

Adds PDF and image handling to the Telegram channel:

- **PDFs** — downloaded, saved to `attachments/`, readable by the agent via `pdf-reader`
- **Images** — downloaded, resized with `sharp`, stored as `[Image: attachments/...]` references and sent to the agent as multimodal content blocks

## Prerequisites

- Telegram channel must be installed (`/add-telegram`)
- `sharp` npm package must be available (`npm install sharp`)

## Phase 1: Pre-flight

### Check if already applied

```bash
grep -q 'processImage' src/channels/telegram.ts 2>/dev/null && echo "ALREADY_APPLIED" || echo "NOT_APPLIED"
```

If already applied, skip to Phase 4 (Verify).

### Check Telegram is installed

```bash
test -f src/channels/telegram.ts && echo "OK" || echo "TELEGRAM_NOT_INSTALLED"
```

If not installed, stop and tell the user to run `/add-telegram` first.

## Phase 2: Install System Dependencies

### Install pdf-reader in the container

Check if the container Dockerfile already has `poppler-utils`:

```bash
grep -q 'poppler-utils' container/Dockerfile && echo "ALREADY_IN_DOCKERFILE" || echo "MISSING"
```

If missing, add `poppler-utils` to the apt-get install block in `container/Dockerfile`:

```dockerfile
    poppler-utils \
```

Also add the pdf-reader CLI install block after `RUN npm run build`:

```dockerfile
# Install pdf-reader CLI
COPY skills/pdf-reader/pdf-reader /usr/local/bin/pdf-reader
RUN chmod +x /usr/local/bin/pdf-reader
```

Check if `container/skills/pdf-reader/` exists:

```bash
ls container/skills/pdf-reader/ 2>/dev/null || echo "MISSING"
```

If missing, fetch from the whatsapp remote:

```bash
git remote get-url whatsapp 2>/dev/null || git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git
git fetch whatsapp skill/pdf-reader
git checkout whatsapp/skill/pdf-reader -- container/skills/pdf-reader/
```

### Install sharp

```bash
npm install sharp
```

## Phase 3: Apply Code Changes

### Add src/image.ts

Check if `src/image.ts` exists:

```bash
test -f src/image.ts && echo "EXISTS" || echo "MISSING"
```

If missing, fetch from the whatsapp remote:

```bash
git fetch whatsapp skill/image-vision 2>/dev/null || true
git checkout whatsapp/skill/image-vision -- src/image.ts src/image.test.ts
```

Then open `src/image.ts` and remove the WhatsApp-specific parts:
- Remove `import type { WAMessage } from '@whiskeysockets/baileys';`
- Remove the `isImageMessage(msg: WAMessage)` function

The remaining exports are `processImage`, `parseImageReferences`, `ProcessedImage`, `ImageAttachment` — all channel-agnostic.

Remove the `isImageMessage` test block from `src/image.test.ts` and update its import to not include `isImageMessage`.

### Extend ContainerInput with imageAttachments

In `src/container-runner.ts`, add to the `ContainerInput` interface:

```typescript
imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
```

In `container/agent-runner/src/index.ts`:

1. Add to `ContainerInput` interface:
   ```typescript
   imageAttachments?: Array<{ relativePath: string; mediaType: string }>;
   ```

2. Add multimodal type definitions after `ContainerInput`:
   ```typescript
   interface ImageContentBlock {
     type: 'image';
     source: { type: 'base64'; media_type: string; data: string };
   }
   interface TextContentBlock {
     type: 'text';
     text: string;
   }
   type ContentBlock = ImageContentBlock | TextContentBlock;
   ```

3. Update `SDKUserMessage.message.content` type:
   ```typescript
   message: { role: 'user'; content: string | ContentBlock[] };
   ```

4. Add `pushMultimodal` method to `MessageStream` class (after the existing `push` method):
   ```typescript
   pushMultimodal(content: ContentBlock[]): void {
     this.queue.push({
       type: 'user',
       message: { role: 'user', content },
       parent_tool_use_id: null,
       session_id: '',
     });
     this.waiting?.();
   }
   ```

5. In `runQuery`, after `stream.push(prompt)`, add image loading:
   ```typescript
   if (containerInput.imageAttachments?.length) {
     const blocks: ContentBlock[] = [];
     for (const img of containerInput.imageAttachments) {
       const imgPath = path.join('/workspace/group', img.relativePath);
       try {
         const data = fs.readFileSync(imgPath).toString('base64');
         blocks.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType as string, data } });
       } catch (err) {
         log(`Failed to load image: ${imgPath}`);
       }
     }
     if (blocks.length > 0) {
       stream.pushMultimodal(blocks);
     }
   }
   ```

### Update src/index.ts

Add import at the top of `src/index.ts`:
```typescript
import { parseImageReferences } from './image.js';
```

In `processGroupMessages`, after `const prompt = formatMessages(...)`:
```typescript
const imageAttachments = parseImageReferences(missedMessages);
```

Update the main `runAgent` call to pass `imageAttachments`:
```typescript
const output = await runAgent(group, prompt, chatJid, imageAttachments, async (result) => {
```

Update the `runAgent` function signature:
```typescript
async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  imageAttachments?: Array<{ relativePath: string; mediaType: string }>,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'>
```

Pass `imageAttachments` to `runContainerAgent`:
```typescript
...(imageAttachments?.length ? { imageAttachments } : {}),
```

For other `runAgent` call sites (session commands, `/compact`), pass `undefined` as `imageAttachments`.

### Update src/channels/telegram.ts

Add imports:
```typescript
import fs from 'fs';
import path from 'path';
import { resolveGroupFolderPath } from '../group-folder.js';
import { processImage } from '../image.js';
```

Replace the photo handler:
```typescript
this.bot.on('message:photo', async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  if (!group) return;

  let placeholder = '[Photo]';
  try {
    const photos = ctx.message.photo;
    const photo = photos[photos.length - 1]; // largest available
    const file = await this.bot!.api.getFile(photo.file_id);
    const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const groupDir = resolveGroupFolderPath(group.folder);
    // Pass empty caption — storeNonText appends ctx.message.caption
    const processed = await processImage(buffer, groupDir, '');
    if (processed) placeholder = processed.content;
  } catch (err) {
    logger.debug({ err }, 'Photo processing failed, using placeholder');
  }

  storeNonText(ctx, placeholder);
});
```

Replace the document handler:
```typescript
this.bot.on('message:document', async (ctx) => {
  const chatJid = `tg:${ctx.chat.id}`;
  const group = this.opts.registeredGroups()[chatJid];
  const doc = ctx.message.document;
  const name = doc?.file_name || 'document';

  if (!group || doc?.mime_type !== 'application/pdf') {
    storeNonText(ctx, `[Document: ${name}]`);
    return;
  }

  let placeholder = `[Document: ${name}]`;
  try {
    const file = await ctx.getFile();
    const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
    const response = await fetch(fileUrl);
    const buffer = Buffer.from(await response.arrayBuffer());
    const groupDir = resolveGroupFolderPath(group.folder);
    const attachDir = path.join(groupDir, 'attachments');
    fs.mkdirSync(attachDir, { recursive: true });
    const filename = name.endsWith('.pdf') ? name : `${name}.pdf`;
    fs.writeFileSync(path.join(attachDir, filename), buffer);
    placeholder = `[PDF attached: attachments/${filename}]`;
    logger.info({ chatJid, filename }, 'PDF attachment saved');
  } catch (err) {
    logger.debug({ err }, 'PDF download failed, using placeholder');
  }

  storeNonText(ctx, placeholder);
});
```

### Build

```bash
npm run build
```

Fix any type errors before proceeding.

## Phase 4: Rebuild Container and Restart

The container needs rebuilding because:
- `poppler-utils` and `pdf-reader` are new in the Dockerfile
- `container/agent-runner/src/index.ts` has multimodal changes

```bash
# Prune builder cache to ensure clean rebuild
docker builder prune -f

./container/build.sh
```

Clear the agent-runner-src cache so all groups pick up the new agent code:

```bash
rm -rf data/sessions/*/agent-runner-src
```

Restart the service:

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

## Phase 5: Verify

### Test PDF

Send a PDF document in a registered Telegram chat. The agent should:
1. Receive `[PDF attached: attachments/filename.pdf]`
2. Be able to read it with `pdf-reader extract attachments/filename.pdf`

### Test image

Send a photo in a registered Telegram chat. The agent should receive it as a multimodal content block and describe what it sees.

### Check logs

```bash
tail -f logs/nanoclaw.log | grep -iE "pdf|photo|image|attachment"
```

Look for:
- `PDF attachment saved` — PDF download succeeded
- `Photo processing failed` — sharp error (check npm install sharp)

## Troubleshooting

**`pdf-reader: command not found` in agent**: Container needs rebuilding. Run `./container/build.sh`.

**PDF not saved**: Check that the file mime_type is `application/pdf`. Some clients send PDFs as generic `application/octet-stream`.

**Image not visible to agent**: Verify `sharp` is installed (`npm ls sharp`). Check that `container/agent-runner/src/index.ts` has the `imageAttachments` changes and the container was rebuilt.

**`Cannot find module '../image.js'`**: The build is missing `src/image.ts`. Re-apply the file from the whatsapp remote (Phase 3).
