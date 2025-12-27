export class MetaService {
  static generateMiniAppTag(imageUrl: string, title: string, actionUrl: string, splashImageUrl?: string, splashBackgroundColor?: string): string {
    const miniapp = {
      version: "1",
      imageUrl: imageUrl,
      button: {
        title: title,
        action: {
          type: "launch_frame",
          name: "qbase",
          url: actionUrl,
          splashImageUrl: splashImageUrl || "https://qbase.tech/splash.png", // Fallback or use env var
          splashBackgroundColor: splashBackgroundColor || "#FFFFFF"
        }
      }
    };

    return `<meta name="fc:miniapp" content='${JSON.stringify(miniapp)}' />`;
  }

  static injectTags(html: string, tags: string): string {
    // Inject before </head>
    return html.replace('</head>', `${tags}</head>`);
  }
}
