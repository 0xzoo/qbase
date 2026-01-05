import { Resvg } from "@cf-wasm/resvg";

// OG Image Service - generates SVG and converts to PNG using resvg-wasm
export class OGService {
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

  // Convert SVG string to PNG using resvg-wasm
  private static svgToPng(svg: string): Uint8Array {
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: 1200,
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

  static generateQuestionImage(text: string, creatorName: string): Uint8Array {
    // Determine font size based on text length
    let fontSize = 72; // Start large
    let maxCharsPerLine = 25;
    
    if (text.length > 80) {
      fontSize = 56;
      maxCharsPerLine = 30;
    }
    if (text.length > 120) {
      fontSize = 48;
      maxCharsPerLine = 35;
    }
    if (text.length > 160) {
      fontSize = 40;
      maxCharsPerLine = 40;
    }
    
    // Truncate very long text
    const displayText = text.length > 200 ? text.substring(0, 197) + '...' : text;
    const lines = this.wrapText(displayText, maxCharsPerLine);
    
    // Calculate vertical positioning for centered text
    const lineHeight = fontSize * 1.3;
    const totalHeight = lines.length * lineHeight;
    const startY = (630 - totalHeight) / 2 + (fontSize * 0.7); // Adjust for text baseline

    const svg = `
      <svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" style="stop-color:#0f172a;stop-opacity:1" />
            <stop offset="50%" style="stop-color:#1e293b;stop-opacity:1" />
            <stop offset="100%" style="stop-color:#334155;stop-opacity:1" />
          </linearGradient>
        </defs>
        
        <!-- Background -->
        <rect width="1200" height="630" fill="url(#bg)"/>
        
        <!-- Subtle overlay for better text contrast -->
        <rect width="1200" height="630" fill="rgba(0,0,0,0.15)"/>
        
        <!-- Question text (wrapped) -->
        ${lines.map((line, i) => `
          <text x="600" y="${startY + (i * lineHeight)}" 
                font-family="system-ui, -apple-system, sans-serif" 
                font-size="${fontSize}" 
                font-weight="700" 
                fill="white" 
                text-anchor="middle">
            ${this.escapeXml(line)}
          </text>
        `).join('')}
        
        <!-- Author info - bottom left (within 945px safe zone) -->
        <g>
          <text x="130" y="580" 
                font-family="system-ui, -apple-system, sans-serif" 
                font-size="22" 
                fill="rgba(255,255,255,0.8)">
            Asked by 
            <tspan font-weight="700" fill="white">@${this.escapeXml(creatorName)}</tspan>
          </text>
        </g>
        
        <!-- qbase branding - bottom right (within 945px safe zone) -->
        <text x="1070" y="580" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="22" 
              font-weight="600"
              fill="rgba(255,255,255,0.6)" 
              text-anchor="end">
          qbase
        </text>
      </svg>
    `.trim();

    return this.svgToPng(svg);
  }

  static generateQuizImage(title: string, creatorName: string, questionCount: number): Uint8Array {
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
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="28" 
              font-weight="600" 
              fill="#a5b4fc" 
              letter-spacing="2">
          QUIZ
        </text>
        
        <!-- Title -->
        <text x="80" y="200" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="64" 
              font-weight="700" 
              fill="white">
          ${this.escapeXml(displayTitle)}
        </text>
        
        <!-- Creator -->
        <text x="80" y="500" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="24" 
              fill="#cbd5e1">
          Created by
        </text>
        <text x="80" y="540" 
              font-family="system-ui, -apple-system, sans-serif" 
              font-size="32" 
              font-weight="600" 
              fill="white">
          @${this.escapeXml(creatorName)}
        </text>
        
        <!-- Question count badge -->
        <rect x="950" y="500" width="200" height="60" rx="30" fill="#3b82f6"/>
        <text x="1050" y="538" 
              font-family="system-ui, -apple-system, sans-serif" 
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
          const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
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
                  font-family="system-ui, -apple-system, sans-serif" 
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
                font-family="system-ui, -apple-system, sans-serif" 
                font-size="68" 
                font-weight="700" 
                fill="#1e293b">
            ask
          </text>
          
          <!-- "username" -->
          <text x="700" y="315" 
                font-family="system-ui, -apple-system, sans-serif" 
                font-size="84" 
                font-weight="700" 
                fill="#7dd3fc">
            ${this.escapeXml(username)}
          </text>
          
          <!-- "anything" -->
          <text x="700" y="410" 
                font-family="system-ui, -apple-system, sans-serif" 
                font-size="68" 
                font-weight="700" 
                fill="#1e293b">
            anything
          </text>
        </g>
        
        <!-- qbase branding - bottom right (within safe zone) -->
        <text x="1050" y="580" 
              font-family="system-ui, -apple-system, sans-serif" 
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
