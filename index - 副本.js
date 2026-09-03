const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

function generateRandomName() {
    return crypto.randomBytes(4).toString('hex');
}

const config = {
    PASSWORD: process.env.PASSWORD || '789456',
    HY2_PORT: Number(process.env.HY2_PORT || 37680),
    FRP_ADR: process.env.FRP_ADR || '20.205.33.26',
    FRP_REMOTE_PORT: Number(process.env.FRP_REMOTE_PORT || 10459),
    FRP_TOKEN: process.env.FRP_TOKEN || '789456',
    FRP_PROXY_NAME: process.env.FRP_PROXY_NAME || generateRandomName(),
    NZ_SERVER: process.env.NZ_SERVER || 'newnz.seav.eu.org:443',
    NZ_CLIENT_SECRET: process.env.NZ_CLIENT_SECRET || 'cRivpR7ScUwP51hJj7rLw7iCbUE6HmKg',
    NZ_UUID: process.env.NZ_UUID || '54dde477-7951-4375-9c04-9764efec02ff',
    PORT: Number(process.env.PORT || 3000)
};

const downloadDir = __dirname;

const fileInfo = {
    'https://download.hysteria.network/app/latest/hysteria-linux-amd64': 'hy2',
    'https://github.com/seav1/dl/releases/download/files/nzv1': 'nzv1',
    'https://github.com/seav1/dl/releases/download/files/frpc': 'frpc'
};

const processes = {
    nzv1: null,
    hy2: null,
    frpc: null
};

let shuttingDown = false;

function generateRandomName() {
    return crypto.randomBytes(4).toString('hex');
}

function downloadFile(url, filename, redirects = 0) {
    return new Promise((resolve, reject) => {
        if (redirects > 10) {
            reject(new Error('Too many redirects'));
            return;
        }

        const client = url.startsWith('https') ? https : http;
        const tempFile = `${filename}.tmp`;

        const request = client.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            },
            timeout: 60000
        }, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                const location = response.headers.location;
                response.resume();

                if (!location) {
                    reject(new Error(`Redirect without location: ${url}`));
                    return;
                }

                const nextUrl = new URL(location, url).toString();
                downloadFile(nextUrl, filename, redirects + 1)
                    .then(resolve)
                    .catch(reject);
                return;
            }

            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error(`HTTP ${response.statusCode}: ${url}`));
                return;
            }

            try {
                if (fs.existsSync(tempFile)) {
                    fs.unlinkSync(tempFile);
                }
            } catch {}

            const file = fs.createWriteStream(tempFile);

            response.pipe(file);

            file.on('finish', () => {
                file.close((err) => {
                    if (err) {
                        try { fs.unlinkSync(tempFile); } catch {}
                        reject(err);
                        return;
                    }

                    try {
                        fs.renameSync(tempFile, filename);
                        fs.chmodSync(filename, 0o755);
                        resolve();
                    } catch (error) {
                        try { fs.unlinkSync(tempFile); } catch {}
                        reject(error);
                    }
                });
            });

            file.on('error', (err) => {
                try { fs.unlinkSync(tempFile); } catch {}
                reject(err);
            });

            response.on('error', (err) => {
                try { fs.unlinkSync(tempFile); } catch {}
                reject(err);
            });
        });

        request.on('timeout', () => {
            request.destroy(new Error(`Download timeout: ${url}`));
        });

        request.on('error', (err) => {
            try { fs.unlinkSync(tempFile); } catch {}
            reject(err);
        });
    });
}

async function downloadFiles() {
    for (const [url, name] of Object.entries(fileInfo)) {
        const filepath = path.join(downloadDir, name);

        if (!fs.existsSync(filepath)) {
            console.log(`Downloading ${name}...`);

            let success = false;

            for (let i = 1; i <= 3; i++) {
                try {
                    await downloadFile(url, filepath);
                    success = true;
                    break;
                } catch (error) {
                    console.error(`Download ${name} failed (${i}/3): ${error.message}`);

                    if (i < 3) {
                        await new Promise(resolve => setTimeout(resolve, 3000));
                    }
                }
            }

            if (!success) {
                throw new Error(`Failed to download ${name}`);
            }
        }
    }
}

function generateSSL() {
    return new Promise((resolve, reject) => {
        if (fs.existsSync('cert.pem') && fs.existsSync('key.pem')) {
            resolve();
            return;
        }

        execFile('openssl', [
            'req',
            '-newkey', 'rsa:2048',
            '-nodes',
            '-keyout', 'key.pem',
            '-x509',
            '-days', '36500',
            '-out', 'cert.pem',
            '-subj', '/CN=bing.com'
        ], {
            timeout: 60000
        }, (error) => {
            if (error) {
                reject(new Error(`SSL certificate generation failed: ${error.message}`));
                return;
            }

            resolve();
        });
    });
}

function createConfigFiles() {
    const hyConfig = `listen: :${config.HY2_PORT}
tls:
  cert: ${path.join(downloadDir, 'cert.pem')}
  key: ${path.join(downloadDir, 'key.pem')}
auth:
  type: password
  password: "${config.PASSWORD.replace(/"/g, '\\"')}"
masquerade:
  type: proxy
  proxy:
    url: https://bing.com
    rewriteHost: true
transport:
  udp:
    hopInterval: 30s
`;

    fs.writeFileSync(path.join(downloadDir, 'config.yaml'), hyConfig);

    const frpcConfig = `[common]
server_addr = "${config.FRP_ADR}"
server_port = 7000
token = "${config.FRP_TOKEN.replace(/"/g, '\\"')}"
[${config.FRP_PROXY_NAME}]
type = "udp"
local_ip = "127.0.0.1"
local_port = ${config.HY2_PORT}
remote_port = ${config.FRP_REMOTE_PORT}
`;

    fs.writeFileSync(path.join(downloadDir, 'frpc.toml'), frpcConfig);
}

function runProcess(name, cmd, args, env = process.env) {
    if (shuttingDown || processes[name]) {
        return;
    }

    const proc = spawn(cmd, args, {
        cwd: downloadDir,
        env,
        stdio: ['ignore', 'ignore', 'pipe']
    });

    processes[name] = proc;

    proc.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message) {
            console.error(`[${name}] ${message}`);
        }
    });

    proc.on('error', (err) => {
        console.error(`[${name}] ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
        processes[name] = null;

        if (!shuttingDown) {
            console.error(`[${name}] exited, restarting in 3 seconds...`);

            setTimeout(() => {
                runServices();
            }, 3000);
        }
    });
}

function runServices() {
    if (fs.existsSync(path.join(downloadDir, 'nzv1')) && !processes.nzv1) {
        const env = {
            ...process.env,
            NZ_SERVER: config.NZ_SERVER,
            NZ_CLIENT_SECRET: config.NZ_CLIENT_SECRET,
            NZ_TLS: 'true'
        };

        if (config.NZ_UUID) {
            env.NZ_UUID = config.NZ_UUID;
        }

        runProcess(
            'nzv1',
            path.join(downloadDir, 'nzv1'),
            [],
            env
        );
    }

    if (fs.existsSync(path.join(downloadDir, 'hy2')) && !processes.hy2) {
        runProcess(
            'hy2',
            path.join(downloadDir, 'hy2'),
            ['server', '-c', path.join(downloadDir, 'config.yaml')]
        );
    }

    if (fs.existsSync(path.join(downloadDir, 'frpc')) && !processes.frpc) {
        runProcess(
            'frpc',
            path.join(downloadDir, 'frpc'),
            ['-c', path.join(downloadDir, 'frpc.toml')]
        );
    }
}

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/plain'
    });
    res.end('OK');
});

function shutdown() {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    Object.values(processes).forEach(proc => {
        if (proc) {
            try {
                proc.kill('SIGTERM');
            } catch {}
        }
    });

    server.close(() => {
        process.exit(0);
    });

    setTimeout(() => {
        process.exit(0);
    }, 3000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

async function init() {
    try {
        await downloadFiles();
        await generateSSL();
        createConfigFiles();
        runServices();

        server.listen(config.PORT, '0.0.0.0', () => {
            console.log('app is running on port ' + config.PORT);
        });
    } catch (error) {
        console.error('Initialization failed:', error.message);
        process.exit(1);
    }
}

init();