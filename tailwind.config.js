/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        rentol: { ink: '#2F4454', dark: '#2E151B', pink: '#DA7B93', teal: '#376E6F', deep: '#1C3334' }
      }
    }
  },
  plugins: []
};
