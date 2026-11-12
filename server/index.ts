import { app } from './app.js';
import { config } from './config.js';
const server = app.listen(config.port, process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1'), () => console.log(`CreatorFlow API listening at http://localhost:${config.port} (${config.mode} mode)`));
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => server.close(() => process.exit(0)));
