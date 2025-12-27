import React from 'react';

// Dynamic WASM imports to avoid initialization errors
let satoriInitialized = false;
let resvgInitialized = false;

async function initSatori() {
  if (!satoriInitialized) {
    const { init } = await import('satori');
    // @ts-ignore
    const yogaWasm = await import('yoga-wasm-web/dist/yoga.wasm?url');
    const yogaModule = await fetch(yogaWasm.default).then(res => res.arrayBuffer());
    await init(yogaModule);
    satoriInitialized = true;
  }
}

async function initResvg() {
  if (!resvgInitialized) {
    const { initWasm } = await import('@resvg/resvg-wasm');
    // @ts-ignore
    const resvgWasm = await import('@resvg/resvg-wasm/index_bg.wasm?url');

    try {
      if (typeof resvgWasm.default === 'string') {
        const response = await fetch(resvgWasm.default);
        await initWasm(response);
      } else {
        await initWasm(resvgWasm.default);
      }
      resvgInitialized = true;
    } catch (e) {
      console.error('Wasm initialization failed:', e);
      throw e;
    }
  }
}

// Initialize WASM (if needed, depending on environment, but often handled by import in workers)
// For Cloudflare Workers, we might need to load the WASM file manually if the auto import doesn't work,
// but let's try the standard approach first.

export class OGService {
  private static async generateImage(element: React.ReactNode, width: number = 1200, height: number = 630): Promise<Uint8Array> {
    // Initialize Satori WASM if not already done
    await initSatori();

    // Dynamically import satori for the actual call
    const satori = (await import('satori')).default;

    // Generate SVG with Satori
    const svg = await satori(element, {
      width,
      height,
      fonts: [
        {
          name: 'Inter',
          // We'll need to load a font. For now, let's use a default system font or fetch one.
          // In a real worker, we should import the font file as an asset or arraybuffer.
          // For this MVP, we might need to fetch a font from a CDN or use a hardcoded buffer if possible.
          // Let's assume we can fetch it for now.
          data: await OGService.loadFont(),
          weight: 400,
          style: 'normal',
        },
      ],
    });

    // Render SVG to PNG with Resvg
    // Note: initWasm might need to be called with the wasm module.
    // In some CF Worker setups, this is tricky.
    // If this fails, we might need to adjust the import.
    await initResvg();

    const { Resvg } = await import('@resvg/resvg-wasm');
    const resvg = new Resvg(svg, {
      fitTo: {
        mode: 'width',
        value: width,
      },
    });

    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();

    return pngBuffer;
  }

  private static async loadFont(): Promise<ArrayBuffer> {
    // Fetch Inter font from Google Fonts or similar CDN
    // This is a temporary solution. Ideally, bundle the font.
    const response = await fetch('https://github.com/google/fonts/raw/main/ofl/inter/Inter-Regular.ttf');
    return await response.arrayBuffer();
  }

  static async generateQuizImage(title: string, creatorName: string, questionCount: number): Promise<Uint8Array> {
    return this.generateImage(
      React.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          width: '100%',
          height: '100%',
          backgroundColor: '#1a1a1a',
          color: 'white',
          padding: '40px',
          fontFamily: 'Inter',
        }
      }, [
        React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column' }
        }, [
          React.createElement('div', {
            style: { fontSize: '24px', opacity: 0.8, marginBottom: '20px' }
          }, 'QUIZ'),
          React.createElement('div', {
            style: { fontSize: '64px', fontWeight: 'bold', lineHeight: 1.1 }
          }, title),
        ]),
        React.createElement('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }
        }, [
          React.createElement('div', {
            style: { display: 'flex', flexDirection: 'column' }
          }, [
            React.createElement('div', { style: { fontSize: '24px', opacity: 0.8 } }, 'Created by'),
            React.createElement('div', { style: { fontSize: '32px' } }, creatorName),
          ]),
          React.createElement('div', {
            style: {
              backgroundColor: '#3b82f6',
              padding: '10px 20px',
              borderRadius: '20px',
              fontSize: '24px',
              fontWeight: 'bold'
            }
          }, `${questionCount} Questions`)
        ])
      ])
    );
  }

  static async generateProfileImage(fid: string, username: string, stats: { level: number, xp: number, rank: number }): Promise<Uint8Array> {
    return this.generateImage(
      React.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          width: '100%',
          height: '100%',
          backgroundColor: '#0f172a',
          color: 'white',
          padding: '60px',
          fontFamily: 'Inter',
        }
      }, [
        // Left: Avatar/User Info
        React.createElement('div', {
          style: { display: 'flex', flexDirection: 'column', flex: 1 }
        }, [
          React.createElement('div', {
            style: {
              width: '200px',
              height: '200px',
              borderRadius: '100px',
              backgroundColor: '#334155',
              marginBottom: '30px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '80px'
            }
          }, username.charAt(0).toUpperCase()),
          React.createElement('div', { style: { fontSize: '48px', fontWeight: 'bold' } }, `@${username}`),
          React.createElement('div', { style: { fontSize: '24px', opacity: 0.7 } }, `FID: ${fid}`),
        ]),
        // Right: Stats
        React.createElement('div', {
          style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '30px',
            backgroundColor: '#1e293b',
            padding: '40px',
            borderRadius: '20px',
            minWidth: '400px'
          }
        }, [
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '32px' } }, [
            React.createElement('span', { style: { opacity: 0.7 } }, 'Level'),
            React.createElement('span', { style: { fontWeight: 'bold' } }, stats.level.toString())
          ]),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '32px' } }, [
            React.createElement('span', { style: { opacity: 0.7 } }, 'XP'),
            React.createElement('span', { style: { fontWeight: 'bold' } }, stats.xp.toLocaleString())
          ]),
          React.createElement('div', { style: { display: 'flex', justifyContent: 'space-between', fontSize: '32px' } }, [
            React.createElement('span', { style: { opacity: 0.7 } }, 'Rank'),
            React.createElement('span', { style: { fontWeight: 'bold', color: '#fbbf24' } }, `#${stats.rank}`)
          ]),
        ])
      ])
    );
  }

  static async generateQuestionImage(text: string, creatorName: string): Promise<Uint8Array> {
    return this.generateImage(
      React.createElement('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          alignItems: 'center',
          width: '100%',
          height: '100%',
          backgroundColor: '#27272a',
          color: 'white',
          padding: '60px',
          textAlign: 'center',
          fontFamily: 'Inter',
        }
      }, [
        React.createElement('div', {
          style: {
            fontSize: '48px',
            fontWeight: 'bold',
            lineHeight: 1.3,
            maxWidth: '90%'
          }
        }, text),
        React.createElement('div', {
          style: {
            marginTop: '60px',
            fontSize: '24px',
            opacity: 0.7,
            display: 'flex',
            alignItems: 'center',
            gap: '10px'
          }
        }, [
          React.createElement('span', {}, 'Asked by'),
          React.createElement('span', { style: { color: '#3b82f6', fontWeight: 'bold' } }, `@${creatorName}`)
        ])
      ])
    );
  }
}
