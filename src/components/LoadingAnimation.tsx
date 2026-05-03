import React from 'react';
import './LoadingAnimation.css';

interface LoadingAnimationProps {
  variant?: 'full' | 'inline' | 'spinner' | 'hero';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * Animated loading component with different variants:
 * - 'full': Full page centered animation with qbase branding
 * - 'inline': Inline skeleton-like pulse animation
 * - 'spinner': Simple spinning animation
 * - 'hero': ASCII art animation of a rotating sentient orb
 */
const LoadingAnimation: React.FC<LoadingAnimationProps> = ({
  variant = 'full',
  size = 'md',
  className = ''
}) => {
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (variant !== 'hero') return;

    let frameId: number;
    const pre = containerRef.current;
    if (!pre) return;

    let A = 0;
    let B = 0;

    // Orb gathering data state
    const particles: { x: number, y: number, z: number, speed: number, char: string }[] = [];
    const dataChars = "010101XYZ";

    const render = () => {
      const width = 120;
      const height = 60;
      const pixelAspect = 11 / 24; // Character aspect ratio approximation

      const buffer = new Array(width * height).fill(' ');
      const zBuffer = new Array(width * height).fill(0);

      // Rotate sphere - slower
      A += 0.003; // Rotation speed X
      B += 0.003; // Rotation speed Z

      // Radius - much bigger
      const R = 28;

      // Light source
      const lx = 0;
      const ly = 1;
      const lz = -1;
      // Normalize light
      const ll = Math.sqrt(lx * lx + ly * ly + lz * lz);
      const nlx = lx / ll;
      const nly = ly / ll;
      const nlz = lz / ll;

      // Expanded shading characters
      const chars = " ..`'-~:;=!*#$@";

      // Render Sphere
      // Denser loops for higher resolution
      for (let j = 0; j < 6.28; j += 0.04) { // theta
        for (let i = 0; i < 6.28; i += 0.015) { // phi
          const c = Math.sin(i);
          const d = Math.cos(j);
          const f = Math.sin(j);
          const _h = d + 2;
          const c2 = Math.cos(i);
          const f2 = Math.sin(A);
          const c2A = Math.cos(A);
          const c2B = Math.cos(B);
          const sB = Math.sin(B);

          // 3D coordinates
          const x = R * c2 * d;
          const y = R * c;
          const z = R * c2 * f;

          // Rotate around X
          const y1 = y * c2A - z * f2;
          const z1 = y * f2 + z * c2A;

          // Rotate around Z
          const x2 = x * c2B - y1 * sB;
          const y2 = x * sB + y1 * c2B;
          const z2 = z1;

          // Project to 2D
          // Z shift for camera
          const ooz = 1 / (z2 + 40);

          const xp = Math.floor(width / 2 + (width / 2) * x2 * ooz * 2 * pixelAspect);
          const yp = Math.floor(height / 2 - (height / 2) * y2 * ooz);

          const idx = xp + yp * width;

          if (idx >= 0 && idx < width * height) {
            if (ooz > zBuffer[idx]) {
              zBuffer[idx] = ooz;

              // Normal vector
              const nx = x / R;
              const ny = y / R;
              const nz = z / R;

              // Rotate normal same way
              const ny1 = ny * c2A - nz * f2;
              const nz1 = ny * f2 + nz * c2A;
              const nx2 = nx * c2B - ny1 * sB;
              const ny2 = nx * sB + ny1 * c2B;
              const nz2 = nz1;

              // Luminance
              const L = (nx2 * nlx + ny2 * nly + nz2 * nlz);
              let luminanceIndex = Math.floor(L * (chars.length - 0.1));

              if (luminanceIndex < 0) luminanceIndex = 0;
              if (luminanceIndex >= chars.length) luminanceIndex = chars.length - 1;

              // "Collecting data" effect: occasionally replace surface with data chars or brighter chars
              const isData = Math.random() > 0.96;
              buffer[idx] = isData ? dataChars[Math.floor(Math.random() * dataChars.length)] : chars[luminanceIndex];
            }
          }
        }
      }

      // Particles
      if (particles.length < 30) {
        // Spawn
        const theta = Math.random() * 6.28;
        const phi = Math.random() * 6.28;
        const rStart = 45 + Math.random() * 15;
        particles.push({
          x: rStart * Math.sin(theta) * Math.cos(phi),
          y: rStart * Math.sin(theta) * Math.sin(phi),
          z: rStart * Math.cos(theta),
          speed: 0.1 + Math.random() * 0.15,
          char: dataChars[Math.floor(Math.random() * dataChars.length)]
        });
      }

      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        // Move towards center
        const d = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        if (d < R - 1) { // Absorbed
          particles.splice(i, 1);
          continue;
        }

        const move = p.speed;
        p.x -= (p.x / d) * move;
        p.y -= (p.y / d) * move;
        p.z -= (p.z / d) * move;

        // Rotate particle with same camera rotation as sphere for consistency
        const f2 = Math.sin(A);
        const c2A = Math.cos(A);
        const c2B = Math.cos(B);
        const sB = Math.sin(B);

        // Rotate around X
        const y1 = p.y * c2A - p.z * f2;
        const z1 = p.y * f2 + p.z * c2A;

        // Rotate around Z
        const x2 = p.x * c2B - y1 * sB;
        const y2 = p.x * sB + y1 * c2B;
        const z2 = z1;

        // Project
        const ooz = 1 / (z2 + 40);
        const xp = Math.floor(width / 2 + (width / 2) * x2 * ooz * 2 * pixelAspect);
        const yp = Math.floor(height / 2 - (height / 2) * y2 * ooz);

        const idx = xp + yp * width;
        if (idx >= 0 && idx < width * height) {
          // Draw if closer than sphere surface (simple check: if buffer is empty or zBuffer small)
          if (ooz > zBuffer[idx]) {
            zBuffer[idx] = ooz;
            buffer[idx] = p.char;
          }
        }
      }

      let txt = "";
      for (let k = 0; k < width * height; k++) {
        txt += k % width === width - 1 ? "\n" : buffer[k];
      }

      if (containerRef.current) {
        containerRef.current.textContent = txt;
      }

      frameId = requestAnimationFrame(render);
    };

    render();

    return () => cancelAnimationFrame(frameId);
  }, [variant]);

  if (variant === 'spinner') {
    return (
      <div className={`loading-spinner-anim ${size} ${className}`}>
        <div className="spinner-ring" />
      </div>
    );
  }

  if (variant === 'inline') {
    return (
      <div className={`loading-inline ${size} ${className}`}>
        <div className="pulse-bar" />
        <div className="pulse-bar short" />
      </div>
    );
  }

  if (variant === 'hero') {
    return (
      <div className={`flex items-center justify-center bg-black overflow-hidden font-mono text-[10px] leading-[10px] text-green-500 whitespace-pre ${className}`}>
        <div ref={containerRef} />
      </div>
    );
  }

  // Full page loading
  return (
    <div className={`loading-full ${className}`}>
      <div className="loading-content">
        <div className="loading-logo">
          <svg
            width="48"
            height="48"
            viewBox="0 0 100 100"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="logo-svg"
          >
            <circle
              cx="50"
              cy="50"
              r="45"
              stroke="currentColor"
              strokeWidth="6"
              strokeLinecap="round"
              className="logo-circle"
            />
            <text
              x="50"
              y="62"
              textAnchor="middle"
              fontSize="36"
              fontWeight="700"
              fill="currentColor"
              className="logo-text"
            >
              q
            </text>
          </svg>
        </div>
        <div className="loading-dots">
          <span className="dot" />
          <span className="dot" />
          <span className="dot" />
        </div>
      </div>
    </div>
  );
};

export default LoadingAnimation;

