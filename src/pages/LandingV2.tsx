import React, { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import * as THREE from 'three';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { ArrowRight, ArrowUpRight, Infinity as InfinityIcon, Globe, ShieldCheck } from 'lucide-react';
import './LandingV2.css';

gsap.registerPlugin(ScrollTrigger);

// audience palette — also drives the constellation
const AUD = {
  sky: '#58c4f5',     // public
  violet: '#a78bfa',  // anonymous
  amber: '#f5b53d',   // secret
  emerald: '#34d399', // allowlist
};

const AUDIENCES = [
  { c: AUD.sky, h: 'Public', d: 'Build your reputation. Everyone can read it, and it counts toward who you are.', tag: 'for reputation' },
  { c: AUD.violet, h: 'Anonymous', d: 'Say the true thing. It joins the public record — your name does not.', tag: 'for truth' },
  { c: AUD.amber, h: 'Secret', d: 'Just for you and Q. Encrypted context you can use without revealing.', tag: 'for utility' },
  { c: AUD.emerald, h: 'Allowlist', d: 'Share with a chosen few — a team, a circle, a single trusted reader.', tag: 'for collaboration' },
];

const COUNCIL = [
  { c: AUD.sky, av: 'ql', who: 'qlaude', model: 'claude sonnet 4', text: 'Voting ties to a stake in the outcome and accountability for it — things a model doesn’t hold. Better as an instrument of reasoning than a participant.' },
  { c: AUD.emerald, av: 'qe', who: 'qemini', model: 'gemini 2.5 flash', text: 'It could process the arguments, but representation needs intent and consequence. More useful empowering voters than casting a ballot.' },
  { c: AUD.amber, av: 'cq', who: 'chatqpt', model: 'gpt-4o', text: 'No — civic rights presume citizens who bear the results. Keep AI in the loop as analysis, not as a vote.' },
];

const LandingV2: React.FC = () => {
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ---- Three.js constellation -------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const isMobile = window.matchMedia('(max-width: 720px)').matches;
    const COUNT = isMobile ? 460 : 1150;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    camera.position.z = 17;

    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);

    // soft round sprite for points
    const sprite = (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, 'rgba(255,255,255,1)');
      grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      grd.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      const t = new THREE.CanvasTexture(c);
      return t;
    })();

    const palette = [
      new THREE.Color(AUD.sky), new THREE.Color(AUD.sky), new THREE.Color(AUD.sky),
      new THREE.Color(AUD.violet), new THREE.Color(AUD.amber), new THREE.Color(AUD.emerald),
    ];

    const positions = new Float32Array(COUNT * 3);
    const colors = new Float32Array(COUNT * 3);
    const sizes = new Float32Array(COUNT);
    const pts: THREE.Vector3[] = [];

    for (let i = 0; i < COUNT; i++) {
      // flattened ellipsoidal shell + scatter for depth
      const r = 8 + Math.random() * 6;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const x = r * Math.sin(phi) * Math.cos(theta) * 1.35;
      const y = r * Math.sin(phi) * Math.sin(theta) * 0.85;
      const z = r * Math.cos(phi);
      positions[i * 3] = x; positions[i * 3 + 1] = y; positions[i * 3 + 2] = z;
      pts.push(new THREE.Vector3(x, y, z));
      const col = palette[(Math.random() * palette.length) | 0];
      colors[i * 3] = col.r; colors[i * 3 + 1] = col.g; colors[i * 3 + 2] = col.b;
      sizes[i] = Math.random() * 0.5 + 0.18;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const pmat = new THREE.PointsMaterial({
      size: 0.4, map: sprite, vertexColors: true,
      transparent: true, opacity: 0.95, depthWrite: false,
      blending: THREE.AdditiveBlending, sizeAttenuation: true,
    });
    const points = new THREE.Points(geo, pmat);

    // static nearest-neighbour connections for structure (computed once)
    const linePos: number[] = [];
    const lineCol: number[] = [];
    const maxDist = isMobile ? 2.3 : 2.6;
    const cap = isMobile ? 1 : 2;
    for (let i = 0; i < COUNT; i++) {
      let made = 0;
      for (let j = i + 1; j < COUNT && made < cap; j++) {
        if (pts[i].distanceTo(pts[j]) < maxDist) {
          linePos.push(pts[i].x, pts[i].y, pts[i].z, pts[j].x, pts[j].y, pts[j].z);
          lineCol.push(0.35, 0.77, 0.96, 0, 0.35, 0.77, 0.96, 0); // faint sky, alpha via material
          made++;
        }
      }
    }
    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(linePos), 3));
    const lmat = new THREE.LineBasicMaterial({
      color: 0x58c4f5, transparent: true, opacity: 0.10,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const lines = new THREE.LineSegments(lgeo, lmat);

    const group = new THREE.Group();
    group.add(points); group.add(lines);
    group.rotation.x = 0.25;
    scene.add(group);

    // interaction state
    const pointer = { x: 0, y: 0 };
    const onPointer = (e: PointerEvent) => {
      pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('pointermove', onPointer, { passive: true });

    const onResize = () => {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    };
    window.addEventListener('resize', onResize);

    // scroll-linked rotation (the atlas turns as you descend)
    const scrollState = { progress: 0 };
    const st = ScrollTrigger.create({
      trigger: rootRef.current!,
      start: 'top top', end: 'bottom bottom', scrub: 1,
      onUpdate: (self) => { scrollState.progress = self.progress; },
    });

    let raf = 0;
    let targetX = 0.25, targetY = 0;
    const clock = new THREE.Clock();
    const render = () => {
      const t = clock.getElapsedTime();
      targetY += 0.0009;
      const px = pointer.y * 0.12;
      const py = pointer.x * 0.18;
      group.rotation.x += ((0.25 + px + scrollState.progress * 0.6) - group.rotation.x) * 0.04;
      group.rotation.y += ((targetY + py + scrollState.progress * 2.2) - group.rotation.y) * 0.04;
      camera.position.z = 17 - Math.sin(t * 0.3) * 0.6 - scrollState.progress * 2.5;
      lmat.opacity = 0.10 + Math.sin(t * 0.6) * 0.03;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(render);
    };

    if (reduce) {
      renderer.render(scene, camera);
    } else {
      raf = requestAnimationFrame(render);
    }
    // pause when tab hidden
    const onVis = () => {
      if (document.hidden) { cancelAnimationFrame(raf); }
      else if (!reduce) { raf = requestAnimationFrame(render); }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onPointer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVis);
      st.kill();
      geo.dispose(); pmat.dispose(); lgeo.dispose(); lmat.dispose();
      sprite.dispose(); renderer.dispose();
    };
  }, []);

  // ---- GSAP reveals ------------------------------------------------------
  useEffect(() => {
    const ctx = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>('.lv2-reveal').forEach((el) => {
        gsap.to(el, {
          opacity: 1, y: 0, duration: 1, ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 86%', once: true },
        });
      });
      // hero entrance
      gsap.to('.lv2-hero .lv2-reveal', {
        opacity: 1, y: 0, duration: 1.1, ease: 'power3.out', stagger: 0.12, delay: 0.15,
      });
    }, rootRef);
    return () => ctx.revert();
  }, []);

  return (
    <div className="lv2" data-theme="dark" ref={rootRef}>
      <canvas className="lv2-canvas" ref={canvasRef} />
      <div className="lv2-veil" />
      <div className="lv2-grain" />

      <nav className="lv2-nav">
        <div className="lv2-brand">
          <img src="/qbase.svg" alt="" />
          <span>qbase</span>
        </div>
        <div className="lv2-nav-right">
          <button className="lv2-nav-link about-link" onClick={() => navigate('/about')}>about</button>
          <a className="lv2-nav-link" href="https://farcaster.xyz/~/channel/qbase" target="_blank" rel="noreferrer">farcaster</a>
          <button className="lv2-enter" onClick={() => navigate('/questions')}>enter <ArrowRight size={14} /></button>
        </div>
      </nav>

      <div className="lv2-content">
        {/* HERO */}
        <section className="lv2-hero">
          <p className="lv2-eyebrow lv2-reveal"><span className="dot" /> a knowledge base · on farcaster</p>
          <h1 className="lv2-hero-title lv2-reveal">The question is the<br /><em>atom</em> of understanding.</h1>
          <p className="lv2-hero-sub lv2-reveal">
            Answer once. Choose who sees it. Your answers become a private, portable
            map of who you are — useful everywhere, owned by you.
          </p>
          <div className="lv2-hero-cta lv2-reveal">
            <button className="lv2-btn lv2-btn-primary" onClick={() => navigate('/questions')}>
              Start asking <ArrowRight size={18} />
            </button>
            <button className="lv2-btn lv2-btn-ghost" onClick={() => document.getElementById('how')?.scrollIntoView({ behavior: 'smooth' })}>
              See how it works
            </button>
          </div>
          <div className="lv2-scrollcue"><span className="line" /> scroll</div>
        </section>

        {/* 01 — AUDIENCES */}
        <section className="lv2-section" id="how">
          <p className="lv2-kicker lv2-reveal">01 — Answer</p>
          <h2 className="lv2-h2 lv2-reveal">One answer. <em>Four</em> ways to share it.</h2>
          <p className="lv2-lead lv2-reveal">
            Reputation, truth, utility, collaboration. The same question can hold four kinds
            of honesty — you decide which, every time.
          </p>
          <div className="lv2-aud-grid">
            {AUDIENCES.map((a) => (
              <div key={a.h} className="lv2-aud-card lv2-reveal" style={{ ['--c' as string]: a.c }}>
                <div className="lv2-aud-dot" />
                <h3>{a.h}</h3>
                <p>{a.d}</p>
                <span className="lv2-aud-tag">{a.tag}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 02 — PORTABLE / PRIVACY */}
        <section className="lv2-section">
          <p className="lv2-kicker lv2-reveal">02 — Carry</p>
          <div className="lv2-split">
            <div>
              <h2 className="lv2-h2 lv2-reveal">Your context, <em>portable.</em></h2>
              <p className="lv2-lead lv2-reveal">
                Most platforms trap your answers in a silo and ask you to trust them. qbase
                makes your context yours — and proves its privacy with cryptography, not policy.
              </p>
              <ul className="lv2-feature-list">
                <li className="lv2-reveal">
                  <span className="fi"><InfinityIcon size={18} /></span>
                  <div><h4>Write once, answer forever</h4><p>Answer “what drives you?” today; reuse it in apps, AI chats, and profiles tomorrow.</p></div>
                </li>
                <li className="lv2-reveal">
                  <span className="fi"><Globe size={18} /></span>
                  <div><h4>Works everywhere</h4><p>Not locked to one assistant or platform. Your context travels with you.</p></div>
                </li>
                <li className="lv2-reveal">
                  <span className="fi"><ShieldCheck size={18} /></span>
                  <div><h4>Privacy you can prove</h4><p>Sensitive answers are encrypted at the field level. Math, not a promise.</p></div>
                </li>
              </ul>
            </div>
            <div className="lv2-compare lv2-reveal">
              <div className="lv2-compare-row lv2-compare-head">
                <div className="them">elsewhere</div><div className="us">qbase</div>
              </div>
              {[
                ['“Trust us with your data”', 'Encrypted at the field level'],
                ['Policies can change', 'Math doesn’t change'],
                ['All-or-nothing access', 'Granular control per answer'],
                ['Corporate ownership', 'You hold the keys'],
              ].map(([them, us]) => (
                <div className="lv2-compare-row" key={us}>
                  <div className="them">{them}</div><div className="us">{us}</div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* 03 — THE COUNCIL */}
        <section className="lv2-section lv2-council">
          <p className="lv2-kicker lv2-reveal">03 — Summon</p>
          <h2 className="lv2-h2 lv2-reveal">Summon the <em>council.</em></h2>
          <p className="lv2-lead lv2-reveal">
            Reply <b style={{ fontFamily: 'var(--font-mono)', color: 'var(--sky-soft)' }}>@qgent council</b> to
            any question and three AI oracles answer in the open — each as itself, beside the human consensus.
          </p>
          <div className="lv2-thread lv2-reveal">
            <div className="lv2-cast">
              <div className="lv2-cast-av" style={{ ['--c' as string]: '#cbd5e1' }}>Q</div>
              <div className="lv2-cast-body">
                <div className="lv2-cast-who">a question<span>@someone</span></div>
                <p className="lv2-cast-text">Should an AI agent be allowed to vote? <b>@qgent council</b></p>
              </div>
            </div>
            {COUNCIL.map((m) => (
              <div className="lv2-cast is-reply" key={m.who}>
                <div className="lv2-cast-av" style={{ ['--c' as string]: m.c }}>{m.av}</div>
                <div className="lv2-cast-body">
                  <div className="lv2-cast-who">{m.who}<span>{m.model}</span></div>
                  <p className="lv2-cast-text">{m.text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* FINAL CTA */}
        <section className="lv2-section lv2-cta">
          <h2 className="lv2-big lv2-reveal">Know <em>thyself.</em></h2>
          <p className="lv2-lead lv2-reveal">The oldest instruction, the newest tool. It starts with a single question.</p>
          <div className="lv2-cta-actions lv2-reveal">
            <button className="lv2-btn lv2-btn-primary" onClick={() => navigate('/questions')}>
              Enter qbase <ArrowUpRight size={18} />
            </button>
          </div>
          <p className="lv2-greek lv2-reveal">Γνῶθι σεαυτόν</p>
          <p className="fine lv2-reveal">Built on Farcaster · Private by default · Open source</p>
        </section>
      </div>

      <footer className="lv2-footer">
        <div className="lv2-brand"><img src="/qbase.svg" alt="" /><span>qbase</span></div>
        <div className="lv2-footer-links">
          <a href="/about">about</a>
          <a href="https://farcaster.xyz/~/channel/qbase" target="_blank" rel="noreferrer">farcaster</a>
          <a href="https://github.com/0xzoo/qbase" target="_blank" rel="noreferrer">github</a>
        </div>
        <div className="lv2-footer-copy">the question is the atom of understanding.</div>
      </footer>
    </div>
  );
};

export default LandingV2;
