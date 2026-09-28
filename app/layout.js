import './globals.css';

export const metadata = {
  title: 'Lewis Bakers - Tema App',
  description: 'Run the JMeter performance test and generate the HTML report.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
