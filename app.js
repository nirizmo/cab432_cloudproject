const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg'); // Replace with the actual path to your FFmpeg executable
const AWS = require('aws-sdk');
const redis = require('redis');
const app = express();
require('dotenv').config();

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: 'ap-southeast-2', // Change to your desired region
});

const s3 = new AWS.S3();
const s3BucketName = 'n8282935-transcodes'; // Change this to your S3 bucket name

// Check if the S3 bucket exists, and create it if not
async function createS3bucket() {
  try {
    await s3.createBucket( { Bucket: s3BucketName }).promise();
    console.log(`Created bucket: ${s3BucketName}`);
  } catch(err) {
    if (err.statusCode === 409) {
      console.log(`Bucket already exists: ${s3BucketName}`);
    } else {
      console.log(`Error creating bucket: ${err}`);
    }
  }
}

(async () => {
  await createS3bucket();
})();

// Configure Redis
const redisClient = redis.createClient();

// Configure multer to use memory storage, as we don't save files locally
const upload = multer();

// Define routes
app.use(express.json());

// Serve static files from the "public" directory
app.use(express.static('public'));

app.post('/upload', upload.single('videoFile'), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;
  const generateThumbnail = req.body.generateThumbnail;

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: 'uploads/' + req.file.originalname,
    Body: uploadedFileBuffer,
  };

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send('Failed to upload the original file to S3');
    }

    // Store job progress in Redis
    const jobId = 'job_' + Date.now(); // Generate a unique job ID
    const jobStatus = {
      status: 'processing',
      progress: 0, // You can update this as the job progresses
    };

    redisClient.set(jobId, JSON.stringify(jobStatus));

    // Transcoding with FFmpeg
    ffmpeg()
      .input(uploadedFileBuffer)
      .videoCodec(format)
      .audioCodec('aac')
      .audioBitrate(bitrate)
      .videoBitrate(bitrate)
      .size(resolution)
      .on('end', () => {
        // Transcoding complete
        if (generateThumbnail) {
          // Generate a thumbnail here if needed
        }

        // Upload the transcoded video to S3
        const transcodedFileParams = {
          Bucket: s3BucketName,
          Key: 'transcoded/' + req.file.originalname,
          Body: uploadedFileBuffer, // Use the buffer of the uploaded file
        };

        s3.upload(transcodedFileParams, (err, transcodedFileData) => {
          if (err) {
            return res.status(500).send('Failed to upload the transcoded video to S3');
          }

          // Update job status in Redis
          jobStatus.status = 'completed';
          jobStatus.progress = 100; // Job is complete
          redisClient.set(jobId, JSON.stringify(jobStatus));

          // Provide download links to the user
          const downloadLink = s3.getSignedUrl('getObject', {
            Bucket: s3BucketName,
            Key: transcodedFileParams.Key,
          });

          res.json({
            message: 'Transcoding complete',
            originalFileData,
            transcodedFileData,
            downloadLink,
            jobId,
          });
        });
      })
      .on('error', (err) => {
        // Handle FFmpeg error
        res.status(500).send('Transcoding failed: ' + err.message);

        // Update job status in Redis
        jobStatus.status = 'failed';
        jobStatus.progress = 0;
        redisClient.set(jobId, JSON.stringify(jobStatus));
      });
  });
});

// Get job status from Redis
app.get('/job/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  redisClient.get(jobId, (err, jobStatus) => {
    if (err) {
      return res.status(500).send('Failed to retrieve job status from Redis');
    }
    if (!jobStatus) {
      return res.status(404).send('Job not found');
    }
    res.json(JSON.parse(jobStatus));
  });
});

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
