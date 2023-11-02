require('dotenv').config()
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const AWS = require('aws-sdk');
const redis = require('redis');
const app = express();
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: process.env.AWS_REGION,
});

// Set S3 bucket
const s3 = new AWS.S3();
const s3BucketName = process.env.S3_BUCKET;

// Check for S3 Bucket
async function createS3bucket() {
  try {
    await s3.createBucket({ Bucket: s3BucketName }).promise();
    console.log(`Created bucket: ${s3BucketName}`);
  } catch (err) {
    if (err.statusCode === 409) {
      console.log(`Bucket successfully located: ${s3BucketName}`);
    } else {
      console.log(`Error creating bucket: ${err}`);
    }
  }
}

(async () => {
  await createS3bucket();
})();

// Configure multer to use memory storage, as we don't save files locally
const upload = multer();

// Serve static files from the "public" directory
app.use(express.static('public'));

// Define routes
app.use(express.json());

// Initialize Redis client
const redisClient = redis.createClient();

// Function to Upload & Transcode
app.post('/upload', upload.single('videoFile'), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;

  let videoCodec;

  if (format === 'mp4') {
    videoCodec = 'libx264';
  } else if (format === 'mov') {
    videoCodec = 'libx264';
  } else if (format === 'avi') {
    videoCodec = 'libxvid';
  } else {
    videoCodec = 'libx264';
  }

  console.log("1. File Uploading...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Generate a unique identifier using uuid
  const uniqueIdentifier = uuid.v4();

  // Append the unique identifier to file name
  const originalFileName = req.file.originalname;
  const extname = path.extname(originalFileName);
  const baseName = path.basename(originalFileName, extname);
  const modifiedFileName = `${baseName}_${uniqueIdentifier}${extname}`;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: 'uploads/' + modifiedFileName,
    Body: uploadedFileBuffer,
  };

  console.log("2. File uploaded to AWS S3");

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send('Failed to upload the original file to S3');
    }

    const outVideoPath = path.join('tmp/', `${path.basename(modifiedFileName, path.extname(modifiedFileName))}.${format}`);
    const ffmpegPath = path.join(__dirname, 'ffmpeg', 'ffmpeg');

    console.log('Path to FFmpeg:', ffmpegPath);

    let readableVideoBuffer = new stream.PassThrough();
    readableVideoBuffer.write(uploadedFileBuffer);
    readableVideoBuffer.end();

    // Define a job object
    const job = {
      format: format,
      videoCodec: videoCodec,
      bitrate: bitrate,
      resolution: resolution,
      inputBuffer: uploadedFileBuffer,
      outVideoPath: outVideoPath,
      originalFileData: originalFileData,
      res: res,
    };

    // Add the job to the Redis queue
    redisClient.rpush('transcoding_queue', JSON.stringify(job), (redisErr) => {
      if (redisErr) {
        console.error('Failed to add job to Redis queue:', redisErr);
        return res.status(500).send('Failed to add job to queue');
      }
    });
  });
});

// Function to handle transcoding jobs
function processTranscodingJob(job) {
  const {
    format,
    videoCodec,
    bitrate,
    resolution,
    inputBuffer,
    outVideoPath,
    originalFileData,
    res,
  } = job;

  ffmpeg()
    .input(inputBuffer)
    .inputFormat('buffer')
    .inputOption('-f mpegts')
    .inputFPS(30)
    .videoCodec(videoCodec)
    .audioCodec('aac')
    .audioBitrate(bitrate)
    .videoBitrate(bitrate)
    .size(resolution)
    .output(outVideoPath)
    .on('end', () => {
      console.log("4. Video transcoded");

      // Transcoding complete

      const transcodedFolder = 'transcodes/';
      const transcodedFileKey = transcodedFolder + `${path.basename(
        outVideoPath,
        path.extname(outVideoPath)
      )}.${format}`;

      // Upload the transcoded video to S3
      const transcodedFileParams = {
        Bucket: s3BucketName,
        Key: transcodedFileKey,
        Body: fs.createReadStream(outVideoPath),
      };

      console.log("5. Transcoded video uploaded");

      s3.upload(transcodedFileParams, (err, transcodedFileData) => {
        if (err) {
          return res.status(500).send('Failed to upload the transcoded video to S3');
        }

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
        });

        console.log("6. Process completed");

        try {
          // Synchronously delete the local video file in the "tmp" directory
          fs.unlinkSync(outVideoPath);
          console.log('Local video file deleted');
        } catch (err) {
          console.error('Error deleting local video file:', err);
        }

        // Mark the job as completed in Redis
        redisClient.lrem('transcoding_queue', 0, JSON.stringify(job), (redisErr) => {
          if (redisErr) {
            console.error('Failed to remove job from Redis queue:', redisErr);
          }
        });
      });
    })
    .on('error', (err) => {
      console.error('FFmpeg error:', err);
      res.status(500).send('Transcoding error');
    })
    .run();
}

// Function to process jobs from the Redis queue
function processQueue() {
  redisClient.lpop('transcoding_queue', (redisErr, job) => {
    if (redisErr || !job) {
      return;
    }

    try {
      const parsedJob = JSON.parse(job);
      processTranscodingJob(parsedJob);
    } catch (err) {
      console.error('Failed to parse job from the queue:', err);
    }
  });
}

// Set up a timer to continuously process the queue
setInterval(processQueue, 1000);

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
