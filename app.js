require('dotenv').config();
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const AWS = require('aws-sdk');
const app = express();
const path = require('path');
const fs = require('fs');
const uuid = require('uuid');
const redis = require('redis');

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

// Configure Redis
const redisClient = redis.createClient();

// Serve static files from the "public" directory
app.use(express.static('public'));

// Define routes
app.use(express.json());

// Configure multer to use memory storage, as we don't save files locally
const upload = multer();

// Function to Upload & Transcode
app.post('/upload', upload.array('videoFile', 2), (req, res) => {
  const videoFiles = req.files;
  const formats = req.body.format;
  const bitrates = req.body.bitrate;
  const resolutions = req.body.resolution;

  const tasks = [];

  videoFiles.forEach((file, index) => {
    const format = formats[index];
    const bitrate = bitrates[index];
    const resolution = resolutions[index];

    const task = {
      file,
      format,
      bitrate,
      resolution,
    };

    tasks.push(task);
  });

  // Push the tasks to a Redis queue
  tasks.forEach((task) => {
    redisClient.lpush('video_processing_queue', JSON.stringify(task));
  });

  res.json({
    message: 'Video processing tasks added to the queue',
  });
});

// Worker function to process video tasks
function processVideoTask(task) {
  const { file, format, bitrate, resolution } = task;

  console.log("1. File Uploading...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = file.buffer;

  // Generate a unique identifier using uuid
  const uniqueIdentifier = uuid.v4();

  // Append the unique identifier to the file name
  const originalFileName = file.originalname;
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
    const ffmpegPath = path.join(__dirname, 'ffmpeg', 'ffmpeg'); // Assuming 'ffmpeg.exe' is in a 'ffmpeg' subdirectory of your root directory

    console.log('Path to FFmpeg:', ffmpegPath);

    let readableVideoBuffer = new stream.PassThrough();
    readableVideoBuffer.write(uploadedFileBuffer);
    readableVideoBuffer.end();

    ffmpeg(readableVideoBuffer)
      .setFfmpegPath(ffmpegPath)
      .outputFormat(format)
      .videoCodec('libx264')
      .audioCodec('aac')
      .audioBitrate(bitrate)
      .videoBitrate(bitrate)
      .size(resolution)
      .on('start', () => {
        console.log("3. Video loaded into ffmpeg")
      })
      .on('end', () => {
        console.log("4. Video transcoded");
        // Transcoding complete
        
        function bufferFile(relPath) {
          return fs.readFileSync(relPath); // zzzz....
        }

        const transcodedFolder = 'transcodes/';
        const transcodedFileKey = transcodedFolder + `${path.basename(modifiedFileName, path.extname(modifiedFileName))}.${format}`;

        // Upload the transcoded video to S3
        const transcodedFileParams = {
          Bucket: s3BucketName,
          Key: transcodedFileKey,
          Body: bufferFile(outVideoPath), // Use the buffer of the uploaded file
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

          console.log("6. Process completed");

          try {
            // Synchronously delete the local video file in the "tmp" directory
            fs.unlinkSync(outVideoPath);
            console.log('Local video file deleted');
          } catch (err) {
            console.error('Error deleting local video file:', err);
          }

          console.log({
            message: 'Transcoding complete',
            originalFileData,
            transcodedFileData,
            downloadLink,
          });
        });
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
      })
      .save(outVideoPath);
  });
}

// Listen for video processing tasks in the Redis queue
function processVideoQueue() {
  redisClient.lpop('video_processing_queue', (err, task) => {
    if (!err && task) {
      processVideoTask(JSON.parse(task));
    }
  });
}

setInterval(processVideoQueue, 1000); // Check for tasks every second

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
