import './globals.css';

export const metadata = {
  title: 'JMeter Test Center',
  description: 'Run the JMeter performance test and generate the HTML report.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
