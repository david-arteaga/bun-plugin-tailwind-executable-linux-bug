import App from './App';

export function SSR() {
  return (
    <html>
      <head>
        <title>My App</title>
      </head>
      <body>
        <App />
      </body>
    </html>
  );
}
