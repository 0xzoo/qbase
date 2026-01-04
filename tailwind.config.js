/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    darkMode: ['selector', '[data-theme="dark"]'],
    theme: {
        extend: {
            colors: {
                qbase: {
                    bg: 'var(--qbase-bg)',
                    sky: 'var(--qbase-bg-sky)',
                    ivory: 'var(--qbase-bg-ivory)',
                    slate: 'var(--qbase-bg-slate)',
                    text: 'var(--qbase-text)',
                    'text-dim': 'var(--qbase-text-dim)',
                    accent: 'var(--qbase-accent)',
                }
            },
            fontFamily: {
                display: ['var(--font-display)', 'sans-serif'],
                body: ['var(--font-body)', 'sans-serif'],
            }
        },
    },
    plugins: [],
}
