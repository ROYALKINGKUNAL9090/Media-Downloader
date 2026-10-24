const express = require('express');
const cors = require('cors');
const ytdl = require('@distube/ytdl-core');
const app = express();
const PORT = 4000;

// Enable CORS so your frontend application can communicate with this backend
app.use(cors());
app.use(express.json());

// Endpoint to fetch video metadata (Title, thumbnails, available formats)
app.get('/video-info', async (req, res) => {
    const videoURL = req.query.url;

    if (!videoURL || !ytdl.validateURL(videoURL)) {
        return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
    }

    try {
        const info = await ytdl.getInfo(videoURL);
        
        // Format the response to send only what the frontend needs
        const videoDetails = {
            title: info.videoDetails.title,
            thumbnail: info.videoDetails.thumbnails[0].url,
            duration: info.videoDetails.lengthSeconds,
            formats: info.formats.map(format => ({
                quality: format.qualityLabel || 'Audio Only',
                container: format.container,
                hasVideo: format.hasVideo,
                hasAudio: format.hasAudio,
                itag: format.itag
            }))
        };

        return res.json(videoDetails);
    } catch (error) {
        console.error('Error fetching video info:', error);
        return res.status(500).json({ error: 'Failed to retrieve video details' });
    }
});

// Endpoint to stream the download directly to the client
app.get('/download', async (req, res) => {
    const { url, itag, format = 'mp4' } = req.query;

    if (!url || !ytdl.validateURL(url)) {
        return res.status(400).json({ error: 'Invalid or missing YouTube URL' });
    }

    try {
        // Fetch info to get the dynamic video title for the file name
        const info = await ytdl.getInfo(url);
        const cleanTitle = info.videoDetails.title.replace(/[^\w\s]/gi, ''); // Clean filename characters
        
        // Set headers to trigger a file download in the browser
        res.header('Content-Disposition', `attachment; filename="${cleanTitle}.${format}"`);

        // Options for ytdl: selection by specific itag (quality) if provided
        const downloadOptions = itag ? { format: itag } : { quality: 'highestvideo' };

        // Pipe the download stream directly into the HTTP response object
        ytdl(url, downloadOptions)
            .on('error', (err) => {
                console.error('Stream error:', err);
                if (!res.headersSent) {
                    res.status(500).json({ error: 'Stream interrupted during download' });
                }
            })
            .pipe(res);

    } catch (error) {
        console.error('Error starting download:', error);
        return res.status(500).json({ error: 'Failed to process download' });
    }
});

app.listen(PORT, () => {
    console.log(`Downloader backend running smoothly at http://localhost:${PORT}`);
});
