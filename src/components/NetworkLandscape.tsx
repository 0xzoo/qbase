import { motion } from 'framer-motion';
import { useEffect, useState, useMemo } from 'react';

const NetworkLandscape = () => {
  const [dimensions, setDimensions] = useState({ width: 1000, height: 800 });

  useEffect(() => {
    setDimensions({ width: window.innerWidth, height: window.innerHeight });
    const handleResize = () => setDimensions({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Generate random pyramids - Reduced count for performance
  const pyramids = useMemo(() => Array.from({ length: 8 }).map((_, i) => {
    const x = Math.random() * 100; // percentage
    const y = 60 + Math.random() * 30; // percentage (lower half of screen)
    const size = 20 + Math.random() * 40;
    return { id: i, x, y, size };
  }), []);

  // Generate connections between nearby pyramids
  const connections = useMemo(() => {
    const conns = [];
    for (let i = 0; i < pyramids.length; i++) {
      for (let j = i + 1; j < pyramids.length; j++) {
        const p1 = pyramids[i];
        const p2 = pyramids[j];
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (dist < 35) { // Connect if close enough
          conns.push({ p1, p2, id: `${i}-${j}` });
        }
      }
    }
    return conns;
  }, [pyramids]);

  return (
    <div className="absolute inset-0 w-full h-full overflow-hidden pointer-events-none" style={{ zIndex: 0, willChange: 'transform' }}>
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${dimensions.width} ${dimensions.height}`}
        preserveAspectRatio="xMidYMid slice"
        style={{ opacity: 0.6 }}
      >
        <defs>
          <linearGradient id="line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="var(--pyramid-sand)" stopOpacity="0.2" />
            <stop offset="50%" stopColor="var(--ocean-blue)" stopOpacity="0.8" />
            <stop offset="100%" stopColor="var(--pyramid-sand)" stopOpacity="0.2" />
          </linearGradient>
          {/* Simplified filter for performance */}
          <filter id="glow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="1" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Horizon Line */}
        <line
          x1="0"
          y1={dimensions.height * 0.6}
          x2={dimensions.width}
          y2={dimensions.height * 0.6}
          stroke="var(--pyramid-sand)"
          strokeWidth="1"
          opacity="0.3"
        />

        {/* Perspective Grid (simplified) */}
        {Array.from({ length: 12 }).map((_, i) => {
          const x = (dimensions.width / 12) * i;
          return (
            <line
              key={`grid-v-${i}`}
              x1={x}
              y1={dimensions.height * 0.6}
              x2={(x - dimensions.width / 2) * 4 + dimensions.width / 2} // Perspective fanning
              y2={dimensions.height}
              stroke="var(--pyramid-sand)"
              strokeWidth="0.5"
              opacity="0.1"
            />
          );
        })}

        {/* Connections */}
        {connections.map((conn, i) => {
          const x1 = (conn.p1.x / 100) * dimensions.width;
          const y1 = (conn.p1.y / 100) * dimensions.height;
          const x2 = (conn.p2.x / 100) * dimensions.width;
          const y2 = (conn.p2.y / 100) * dimensions.height;

          return (
            <g key={conn.id}>
              <motion.line
                x1={x1}
                y1={y1 - conn.p1.size} // Top of pyramid 1
                x2={x2}
                y2={y2 - conn.p2.size} // Top of pyramid 2
                stroke="url(#line-gradient)"
                strokeWidth="1"
                strokeDasharray="5 5"
                initial={{ pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 0.4 }}
                transition={{ duration: 2, delay: i * 0.1 }}
              />
              {/* Data Packet - Reduced frequency */}
              <circle r="2" fill="var(--ocean-blue)" filter="url(#glow)">
                <animateMotion
                  dur={`${3 + Math.random() * 4}s`}
                  repeatCount="indefinite"
                  path={`M${x1},${y1 - conn.p1.size} L${x2},${y2 - conn.p2.size}`}
                  calcMode="linear"
                />
              </circle>
            </g>
          );
        })}

        {/* Pyramids */}
        {pyramids.map((p, i) => {
          const px = (p.x / 100) * dimensions.width;
          const py = (p.y / 100) * dimensions.height;
          const s = p.size;

          // Pyramid vertices
          const top = `${px},${py - s}`;
          const left = `${px - s},${py}`;
          const right = `${px + s},${py}`;
          const center = `${px},${py + s * 0.3}`; // Perspective center base

          return (
            <motion.g
              key={p.id}
              initial={{ opacity: 0, scale: 0 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 1, delay: i * 0.1, ease: "easeOut" }}
              style={{ willChange: 'opacity, transform' }}
            >
              {/* Left Face */}
              <polygon
                points={`${top} ${left} ${center}`}
                fill="none"
                stroke="var(--pyramid-sand)"
                strokeWidth="1"
                opacity="0.5"
              />
              {/* Right Face */}
              <polygon
                points={`${top} ${right} ${center}`}
                fill="none"
                stroke="var(--pyramid-sand)"
                strokeWidth="1"
                opacity="0.3"
              />
              {/* Base (implied) */}
              <line x1={px - s} y1={py} x2={px + s} y2={py} stroke="var(--pyramid-sand)" strokeWidth="1" opacity="0.2" />
            </motion.g>
          );
        })}

      </svg>
    </div>
  );
};

export default NetworkLandscape;
