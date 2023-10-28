require('dotenv').config()

const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const AWS = require('aws-sdk');
const { default: ffmpegPath } = require('ffmpeg-static');
const app = express();

// Configure AWS S3
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  sessionToken: process.env.AWS_SESSION_TOKEN,
  region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();
const s3BucketName = process.env.S3_BUCKET;

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

// Configure multer to use memory storage, as we don't save files locally
const upload = multer();

// Serve static files from the "public" directory
app.use(express.static('public'));

// Define routes
app.use(express.json());

app.post('/upload', upload.single('videoFile'), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;
  const generateThumbnail = req.body.generateThumbnail;

  console.log("Uploading file...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: 'uploads/' + req.file.originalname,
    Body: uploadedFileBuffer,
  };

  console.log("Uploaded file to AWS S3");

  ffmpegPaath = ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
  console.log(ffmpegPaath)

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send('Failed to upload the original file to S3');
    }

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

        console.log("Video transcoded");

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
        });
      })
      .on('error', (err) => {
        // Handle FFmpeg error
        res.status(500).send('Transcoding failed: ' + err.message);
      });
  });
});

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
