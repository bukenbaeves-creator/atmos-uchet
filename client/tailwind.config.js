/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef4ff',
          100: '#dbe6fe',
          500: '#3b62d6',
          600: '#2f4fb8',
          700: '#26409a',
        },
      },
    },
  },
  plugins: [],
};
