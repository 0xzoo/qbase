// Resvg is lazy-loaded the first time we actually render an SVG. The
// `@cf-wasm/resvg` package compiles WebAssembly at module init, which
// breaks the vitest pool (it disallows runtime WASM compilation) and
// adds unnecessary cold-start cost when a worker invocation never hits
// an OG endpoint. Caching the constructor at module scope keeps the cost
// to "exactly once per worker isolate" in production.
type ResvgCtor = typeof import('@cf-wasm/resvg').Resvg;
let ResvgClass: ResvgCtor | null = null;
async function loadResvg(): Promise<ResvgCtor> {
  if (!ResvgClass) {
    const mod = await import('@cf-wasm/resvg');
    ResvgClass = mod.Resvg;
  }
  return ResvgClass;
}

// Font cache - loaded once per worker instance
let fontBuffers: Uint8Array[] | null = null;
// Logo cache - loaded once per worker instance
let qbaseLogoDataUrl: string | null = null;
// Memoized init promise — concurrent cold callers await one populated result.
let ogInitPromise: Promise<void> | null = null;

// OG Image Service - generates SVG and converts to PNG using resvg-wasm
export class OGService {
  // Helper to convert ArrayBuffer to base64 (handles large files)
  private static arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode(...chunk);
    }
    return btoa(binary);
  }

  // Initialize fonts and logo from ASSETS binding - call this once before generating images.
  // Memoizes the *promise* so concurrent cold callers await one fully-populated
  // result. The previous form assigned an empty `fontBuffers` up front, so a
  // second concurrent caller could proceed and render with zero fonts (garbled
  // or failed OG image). Module caches are assigned only once fully built.
  static initFonts(assets: { fetch: (request: Request | string) => Promise<Response> }): Promise<void> {
    if (!ogInitPromise) {
      ogInitPromise = (async () => {
        const fontPaths = [
          '/fonts/AlbertSans/AlbertSans-Bold.ttf',
          '/fonts/AlbertSans/AlbertSans-Medium.ttf',
          '/fonts/AlbertSans/AlbertSans-Regular.ttf',
        ];

        const buffers: Uint8Array[] = [];
        for (const path of fontPaths) {
          try {
            const response = await assets.fetch(new Request(`https://dummy${path}`));
            if (response.ok) {
              buffers.push(new Uint8Array(await response.arrayBuffer()));
            } else {
              console.error(`[OGService] font ${path} -> HTTP ${response.status}`);
            }
          } catch (error) {
            console.error(`[OGService] error loading font ${path}:`, error);
          }
        }

        if (buffers.length === 0) {
          // Never cache a fontless result — reset so the next call retries.
          ogInitPromise = null;
          throw new Error('OGService: no fonts loaded');
        }
        fontBuffers = buffers;
        console.log(`[OGService] Loaded ${buffers.length} fonts`);

        // Logo is best-effort — a missing logo doesn't fail the image.
        if (!qbaseLogoDataUrl) {
          try {
            const response = await assets.fetch(new Request('https://dummy/icon-trans.png'));
            if (response.ok) {
              const arrayBuffer = await response.arrayBuffer();
              qbaseLogoDataUrl = `data:image/png;base64,${OGService.arrayBufferToBase64(arrayBuffer)}`;
              console.log(`[OGService] Loaded qbase logo (${arrayBuffer.byteLength} bytes)`);
            } else {
              console.error(`[OGService] logo -> HTTP ${response.status}`);
            }
          } catch (error) {
            console.error('[OGService] error loading logo:', error);
          }
        }
      })();
    }
    return ogInitPromise;
  }
  
  private static escapeXml(unsafe: string): string {
    return unsafe.replace(/[<>&'"]/g, (c) => {
      switch (c) {
        case '<': return '&lt;';
        case '>': return '&gt;';
        case '&': return '&amp;';
        case "'": return '&apos;';
        case '"': return '&quot;';
        default: return c;
      }
    });
  }

  // Convert SVG string to PNG using resvg-wasm with loaded fonts
  private static async svgToPng(svg: string): Promise<Uint8Array> {
    const Resvg = await loadResvg();
    // Resvg.async() awaits wasm readiness — the sync `new Resvg()` throws
    // "Resvg is not yet ready" on a cold isolate's first render.
    const resvg = await Resvg.async(svg, {
      fitTo: {
        mode: 'width',
        value: 1200,
      },
      font: {
        fontBuffers: fontBuffers || [],
        loadSystemFonts: false,
        defaultFontFamily: 'Albert Sans',
      },
    });
    const pngData = resvg.render();
    return pngData.asPng();
  }

  private static wrapText(text: string, maxCharsPerLine: number = 40): string[] {
    const words = text.split(' ');
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      if ((currentLine + word).length > maxCharsPerLine) {
        if (currentLine) lines.push(currentLine.trim());
        currentLine = word + ' ';
      } else {
        currentLine += word + ' ';
      }
    }
    if (currentLine) lines.push(currentLine.trim());

    // Limit to 4 lines max
    return lines.slice(0, 4);
  }

  static async generateQuestionImage(
    text: string, 
    creatorName: string, 
    isTemplate: boolean = false, 
    answerOptions?: string[],
    pfpUrl?: string,
    answerCount: number = 0
  ): Promise<Uint8Array> {
    // Handle template questions with answer options
    let displayText = text;
    let optionLines: string[] = [];
    
    if (isTemplate && answerOptions && answerOptions.length > 0) {
      // Show question with answer options below
      // Truncate long questions when showing options
      if (text.length > 100) {
        displayText = text.substring(0, 97) + '...';
      }
      // Take first 3 options max
      optionLines = answerOptions.slice(0, 3);
    }
    
    // Determine font size based on text length
    let fontSize = 72; // Start large
    let maxCharsPerLine = 25;
    
    if (displayText.length > 80) {
      fontSize = 56;
      maxCharsPerLine = 30;
    }
    if (displayText.length > 120) {
      fontSize = 48;
      maxCharsPerLine = 35;
    }
    if (displayText.length > 160) {
      fontSize = 40;
      maxCharsPerLine = 40;
    }
    
    // If we have answer options, use smaller font for main text
    if (optionLines.length > 0) {
      fontSize = Math.min(fontSize, 56);
      maxCharsPerLine = 30;
    }
    
    // Truncate very long text
    const finalText = displayText.length > 200 ? displayText.substring(0, 197) + '...' : displayText;
    const lines = this.wrapText(finalText, maxCharsPerLine);
    
    // Calculate vertical positioning for centered text
    const lineHeight = fontSize * 1.3;
    const questionHeight = lines.length * lineHeight;
    
    // If we have options, add space for them
    const optionFontSize = 32;
    const optionLineHeight = optionFontSize * 1.5;
    const optionsHeight = optionLines.length > 0 ? (optionLines.length * optionLineHeight + 40) : 0;
    
    const totalHeight = questionHeight + optionsHeight;
    const startY = (630 - totalHeight) / 2 + (fontSize * 0.7); // Adjust for text baseline

    // Fetch PFP if available
    let pfpDataUrl: string | undefined;
    if (pfpUrl) {
      try {
        console.log(`[OGService] Fetching PFP from: ${pfpUrl}`);
        const response = await fetch(pfpUrl);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const base64 = this.arrayBufferToBase64(arrayBuffer);
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          pfpDataUrl = `data:${contentType};base64,${base64}`;
          console.log(`[OGService] Loaded PFP (${arrayBuffer.byteLength} bytes)`);
        } else {
          console.error(`[OGService] Failed to fetch PFP: ${response.status}`);
        }
      } catch (error) {
        console.error('[OGService] Error fetching PFP for question embed:', error);
      }
    } else {
      console.log('[OGService] No PFP URL provided');
    }
    
    console.log(`[OGService] qbaseLogoDataUrl loaded: ${!!qbaseLogoDataUrl}`);
    console.log(`[OGService] pfpDataUrl loaded: ${!!pfpDataUrl}`);

    // PFP dimensions
    const pfpSize = 36;
    const pfpX = 250;
    const pfpY = 600 - pfpSize / 2 - 5; // Center vertically with text

    // Answer count text
    const answerText = answerCount === 1 ? '1 answer' : `${answerCount} answers`;

    // Logo dimensions  
    const logoSize = 40;
    const logoX = 1050 - logoSize;
    const logoY = 600 - logoSize / 2 - 5;

    const svg = `
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#0f172a;stop-opacity:1" />
            <stop offset="50%" style="stop-color:#1e293b;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#334155;stop-opacity:1" />
          </linearGradient>
          <clipPath id="pfpClip">
            <circle cx="${pfpX + pfpSize / 2}" cy="${pfpY + pfpSize / 2}" r="${pfpSize / 2}"/>
          </clipPath>
        </defs>
        
        <!-- Background -->
        <rect width="1200" height="630" fill="url(#bg)"/>
        
        <!-- Subtle overlay for better text contrast -->
        <rect width="1200" height="630" fill="rgba(0,0,0,0.15)"/>
        
        <!-- Question text (wrapped) -->
        ${lines.map((line, i) => `
          <text x="600" y="${startY + (i * lineHeight)}" 
                font-family="Albert Sans" 
                font-size="${fontSize}" 
                font-weight="700" 
                fill="white" 
                text-anchor="middle">
            ${this.escapeXml(line)}
          </text>
        `).join('')}
        
        <!-- Answer options (if present) -->
        ${optionLines.length > 0 ? optionLines.map((option, i) => {
          const optionY = startY + questionHeight + 40 + (i * optionLineHeight);
          return `
          <g>
            <circle cx="250" cy="${optionY - 8}" r="8" fill="#60a5fa" opacity="0.8"/>
            <text x="275" y="${optionY}" 
                  font-family="Albert Sans" 
                  font-size="${optionFontSize}" 
                  font-weight="500" 
                  fill="rgba(255,255,255,0.9)">
              ${this.escapeXml(option.length > 60 ? option.substring(0, 57) + '...' : option)}
            </text>
          </g>
        `;
        }).join('') : ''}
        
        <!-- Author info - bottom left -->
        <!-- Author info: asked by {pfp} {username} -->
        <g>
          <text x="150" y="600" 
                font-family="Albert Sans" 
                font-size="22" 
                fill="rgba(255,255,255,0.8)">
            asked by
          </text>
          ${pfpDataUrl ? `
            <!-- Coiner PFP -->
            <image href="${pfpDataUrl}" 
                   x="${pfpX}" y="${pfpY}" 
                   width="${pfpSize}" height="${pfpSize}" 
                   clip-path="url(#pfpClip)"
                   preserveAspectRatio="xMidYMid slice"/>
            <circle cx="${pfpX + pfpSize / 2}" cy="${pfpY + pfpSize / 2}" r="${pfpSize / 2}" 
                    fill="none" stroke="rgba(255,255,255,0.2)" stroke-width="2"/>
          ` : ''}
          <text x="${pfpDataUrl ? pfpX + pfpSize + 10 : 150}" y="600" 
                font-family="Albert Sans" 
                font-size="22" 
                font-weight="700"
                fill="white">
            ${this.escapeXml(creatorName)}
          </text>
        </g>
        
        <!-- Answer count - center bottom -->
        <text x="600" y="600" 
              font-family="Albert Sans" 
              font-size="20" 
              fill="rgba(255,255,255,0.6)"
              text-anchor="middle">
          ${answerText}
        </text>
        
        <!-- qbase logo - bottom right -->
        <!-- qbase logo + wordmark -->
        <g>
          ${qbaseLogoDataUrl ? `
            <image href="${qbaseLogoDataUrl}" 
                   x="${logoX - 70}" y="${logoY}" 
                   width="${logoSize}" height="${logoSize}"
                   preserveAspectRatio="xMidYMid meet"/>
          ` : ''}
          <text x="1050" y="600" 
                font-family="Albert Sans" 
                font-size="22" 
                font-weight="600"
                fill="rgba(255,255,255,0.6)" 
                text-anchor="end">
            qbase
          </text>
        </g>
      </svg>
    `.trim();

    return this.svgToPng(svg);
  }

  /**
   * Aggregate results chart for /question/:id/results cast embeds.
   * Horizontal bars for mc/checkbox/scale distributions; text questions
   * (empty rows) fall back to a big responder count.
   */
  static async generateResultsImage(
    stem: string,
    rows: Array<{ label: string; count: number; pct: number }>,
    total: number,
  ): Promise<Uint8Array> {
    const MAX_BARS = 5;
    const bars = rows.slice(0, MAX_BARS);
    const hiddenCount = rows.length - bars.length;
    const answerText = total === 1 ? '1 answer' : `${total} answers`;

    // Stem: up to 2 lines, sized down for longer text
    const fontSize = stem.length > 70 ? 36 : 44;
    const maxChars = stem.length > 70 ? 56 : 44;
    const stemLines = this.wrapText(stem, maxChars).slice(0, 2);
    if (stemLines.length === 2 && stem.length > maxChars * 2) {
      stemLines[1] = stemLines[1].substring(0, maxChars - 1) + '…';
    }
    const stemLineHeight = fontSize * 1.25;

    const winnerCount = bars.reduce((max, b) => Math.max(max, b.count), 0);
    const barsStartY = 90 + stemLines.length * stemLineHeight + 30;
    const rowHeight = 66;
    const trackX = 80;
    const trackWidth = 1040;

    const truncateLabel = (label: string) =>
      label.length > 42 ? label.substring(0, 39) + '…' : label;

    const barsSvg = bars.map((bar, i) => {
      const y = barsStartY + i * rowHeight;
      const fillWidth = Math.max(6, Math.round((trackWidth * bar.pct) / 100));
      const isWinner = bar.count === winnerCount && bar.count > 0;
      return `
        <g>
          <text x="${trackX}" y="${y + 16}"
                font-family="Albert Sans" font-size="23" font-weight="600"
                fill="rgba(255,255,255,0.92)">${this.escapeXml(truncateLabel(bar.label))}</text>
          <text x="${trackX + trackWidth}" y="${y + 16}"
                font-family="Albert Sans" font-size="22" font-weight="700"
                fill="${isWinner ? '#7dd3fc' : 'rgba(255,255,255,0.65)'}"
                text-anchor="end">${bar.pct}%</text>
          <rect x="${trackX}" y="${y + 26}" width="${trackWidth}" height="22" rx="11"
                fill="rgba(255,255,255,0.08)"/>
          <rect x="${trackX}" y="${y + 26}" width="${fillWidth}" height="22" rx="11"
                fill="${isWinner ? '#7dd3fc' : '#3b82f6'}"/>
        </g>`;
    }).join('');

    const hiddenSvg = hiddenCount > 0 ? `
      <text x="${trackX}" y="${barsStartY + bars.length * rowHeight + 8}"
            font-family="Albert Sans" font-size="20"
            fill="rgba(255,255,255,0.5)">+ ${hiddenCount} more option${hiddenCount === 1 ? '' : 's'}</text>` : '';

    // Text questions: no distribution — show a big centered count instead
    const emptyStateSvg = bars.length === 0 ? `
      <text x="600" y="380" font-family="Albert Sans" font-size="120" font-weight="700"
            fill="#7dd3fc" text-anchor="middle">${total}</text>
      <text x="600" y="440" font-family="Albert Sans" font-size="28"
            fill="rgba(255,255,255,0.7)" text-anchor="middle">${total === 1 ? 'person has' : 'people have'} answered</text>` : '';

    const logoSize = 40;
    const svg = `
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#0f172a;stop-opacity:1" />
            <stop offset="50%" style="stop-color:#1e293b;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#334155;stop-opacity:1" />
          </linearGradient>
        </defs>

        <rect width="1200" height="630" fill="url(#bg)"/>
        <rect width="1200" height="630" fill="rgba(0,0,0,0.15)"/>

        <!-- Question stem -->
        ${stemLines.map((line, i) => `
          <text x="80" y="${90 + i * stemLineHeight}"
                font-family="Albert Sans" font-size="${fontSize}" font-weight="700"
                fill="white">${this.escapeXml(line)}</text>
        `).join('')}

        ${barsSvg}
        ${hiddenSvg}
        ${emptyStateSvg}

        <!-- Footer (count omitted when the empty state already shows it) -->
        ${bars.length > 0 ? `
        <text x="80" y="600" font-family="Albert Sans" font-size="22"
              fill="rgba(255,255,255,0.7)">${answerText}</text>` : ''}
        <g>
          ${qbaseLogoDataUrl ? `
            <image href="${qbaseLogoDataUrl}"
                   x="${1050 - logoSize - 70}" y="${600 - logoSize / 2 - 5}"
                   width="${logoSize}" height="${logoSize}"
                   preserveAspectRatio="xMidYMid meet"/>
          ` : ''}
          <text x="1050" y="600"
                font-family="Albert Sans" font-size="22" font-weight="600"
                fill="rgba(255,255,255,0.6)" text-anchor="end">qbase</text>
        </g>
      </svg>
    `.trim();

    return this.svgToPng(svg);
  }

  static async generateQuizImage(title: string, creatorName: string, questionCount: number): Promise<Uint8Array> {
    const displayTitle = title.length > 50 ? title.substring(0, 47) + '...' : title;
    
    const svg = `
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bgQuiz" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#312e81;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#1e1b4b;stop-opacity:1" />
          </linearGradient>
        </defs>
        
        <!-- Background -->
        <rect width="1200" height="630" fill="url(#bgQuiz)"/>
        
        <!-- QUIZ label -->
        <text x="80" y="100" 
              font-family="Albert Sans" 
              font-size="28" 
              font-weight="600" 
              fill="#a5b4fc" 
              letter-spacing="2">
          QUIZ
        </text>
        
        <!-- Title -->
        <text x="80" y="200" 
              font-family="Albert Sans" 
              font-size="64" 
              font-weight="700" 
              fill="white">
          ${this.escapeXml(displayTitle)}
        </text>
        
        <!-- Creator -->
        <text x="80" y="500" 
              font-family="Albert Sans" 
              font-size="24" 
              fill="#cbd5e1">
          Created by
        </text>
        <text x="80" y="540" 
              font-family="Albert Sans" 
              font-size="32" 
              font-weight="600" 
              fill="white">
          @${this.escapeXml(creatorName)}
        </text>
        
        <!-- Question count badge -->
        <rect x="950" y="500" width="200" height="60" rx="30" fill="#3b82f6"/>
        <text x="1050" y="538" 
              font-family="Albert Sans" 
              font-size="24" 
              font-weight="700" 
              fill="white" 
              text-anchor="middle">
          ${questionCount} Questions
        </text>
      </svg>
    `.trim();

    return this.svgToPng(svg);
  }

  static async generateProfileImage(username: string, pfpUrl: string | undefined): Promise<Uint8Array> {
    const initial = username.charAt(0).toUpperCase();
    
    // Fetch and convert PFP to base64 if available
    let pfpDataUrl: string | undefined;
    if (pfpUrl) {
      try {
        const response = await fetch(pfpUrl);
        if (response.ok) {
          const arrayBuffer = await response.arrayBuffer();
          const base64 = this.arrayBufferToBase64(arrayBuffer);
          const contentType = response.headers.get('content-type') || 'image/jpeg';
          pfpDataUrl = `data:${contentType};base64,${base64}`;
        }
      } catch (error) {
        console.error('Error fetching PFP for embed:', error);
        // Will fall back to initial
      }
    }

    const svg = `
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bgProfile" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#BFEAF5;stop-opacity:1" />
            <stop offset="50%" style="stop-color:#FDFBF7;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#E2E8F0;stop-opacity:1" />
          </linearGradient>
          <clipPath id="circleClip">
            <circle cx="400" cy="315" r="200"/>
          </clipPath>
        </defs>
        
        <!-- Background -->
        <rect width="1200" height="630" fill="url(#bgProfile)"/>
        
        <!-- Left side: Large Avatar (within safe zone) -->
        <g>
          ${pfpDataUrl ? `
            <!-- User's actual PFP (embedded as data URL) -->
            <image href="${pfpDataUrl}" 
                   x="200" y="115" 
                   width="400" height="400" 
                   clip-path="url(#circleClip)"
                   preserveAspectRatio="xMidYMid slice"/>
          ` : `
            <!-- Fallback: Avatar circle with initial -->
            <circle cx="400" cy="315" r="200" fill="#64748b"/>
            <text x="400" y="375" 
                  font-family="Albert Sans" 
                  font-size="140" 
                  font-weight="700" 
                  fill="white" 
                  text-anchor="middle">
              ${this.escapeXml(initial)}
            </text>
          `}
          <!-- Border ring -->
          <circle cx="400" cy="315" r="200" fill="none" stroke="rgba(0,0,0,0.1)" stroke-width="4"/>
        </g>
        
        <!-- Right side: Text content (stacked and centered) -->
        <g>
          <!-- "ask" -->
          <text x="700" y="220" 
                font-family="Albert Sans" 
                font-size="68" 
                font-weight="700" 
                fill="#1e293b">
            ask
          </text>
          
          <!-- "username" -->
          <text x="700" y="315" 
                font-family="Albert Sans" 
                font-size="84" 
                font-weight="700" 
                fill="#7dd3fc">
            ${this.escapeXml(username)}
          </text>
          
          <!-- "anything" -->
          <text x="700" y="410" 
                font-family="Albert Sans" 
                font-size="68" 
                font-weight="700" 
                fill="#1e293b">
            anything
          </text>
        </g>
        
        <!-- qbase branding - bottom right (within safe zone) -->
        <text x="1050" y="600" 
              font-family="Albert Sans" 
              font-size="20" 
              font-weight="600"
              fill="#64748b" 
              text-anchor="end">
          qbase
        </text>
      </svg>
    `.trim();

    return this.svgToPng(svg);
  }
}
