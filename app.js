require('dotenv').config()
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const stream = require('stream');
const AWS = require('aws-sdk');
const app = express();
const path = require('path'); // Import the path module

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
    await s3.createBucket( { Bucket: s3BucketName }).promise();
    console.log(`Created bucket: ${s3BucketName}`);
  } catch(err) {
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

// Function to Upload & Transcode
app.post('/upload', upload.single('videoFile'), (req, res) => {
  const format = req.body.format;
  const bitrate = req.body.bitrate;
  const resolution = req.body.resolution;
  const generateThumbnail = req.body.generateThumbnail;

  let videoCodec;
  let fileExtension;

  if (format === 'mp4') {
    videoCodec = 'libx264';
    fileExtension = 'mp4';
  } else if (format === 'mkv') {
    videoCodec = 'libx265';
    fileExtension = 'mkv';
  } else {
    // Default values in case format is not recognized
    videoCodec = 'libx264';
    fileExtension = 'mp4';
  }

  console.log("1. File Uploading...");

  // Access the uploaded file from memory
  const uploadedFileBuffer = req.file.buffer;

  // Upload the original file to S3
  const originalFileParams = {
    Bucket: s3BucketName,
    Key: 'uploads/' + req.file.originalname,
    Body: uploadedFileBuffer,
  };

  console.log("2. File uploaded to AWS S3");

  s3.upload(originalFileParams, (err, originalFileData) => {
    if (err) {
      return res.status(500).send('Failed to upload the original file to S3');
    }

    //const inputVideoPath = path.join('uploads/', req.file.originalname);
    //const outVideoPath = path.join('uploads/', req.file.originalname);

    //const formatExtension = format === 'mp4' ? 'mp4' : 'mkv';
    const outVideoPath = path.join('uploads/', `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.${fileExtension}`);

    const ffmpegPath = path.join(__dirname, 'ffmpeg', 'ffmpeg'); // Assuming 'ffmpeg.exe' is in a 'ffmpeg' subdirectory of your root directory

    // Now you can use 'ffmpegPath' to reference the FFmpeg executable in your Node.js application
    console.log('Path to FFmpeg:', ffmpegPath);

    let readableVideoBuffer = new stream.PassThrough();
    readableVideoBuffer.write(uploadedFileBuffer);
    readableVideoBuffer.end();

    ffmpeg(readableVideoBuffer)
      .setFfmpegPath(ffmpegPath)
      .videoCodec(videoCodec)
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
        if (generateThumbnail) {
          // Generate a thumbnail here if needed
        }       

        // Upload the transcoded video to S3
        const transcodedFileParams = {
          Bucket: s3BucketName,
          Key: 'transcoded/' + req.file.originalname,
          Body: uploadedFileBuffer, // Use the buffer of the uploaded file
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
        });
        console.log("6. Process completed");
      })
      .on('error', (err) => {
        console.error('FFmpeg error:', err);
      })
      //.on('stderr', (stderr) => { console.error('FFmpeg stderr:', stderr); })
      .save(outVideoPath);
  });
});

// Start the Express server
app.listen(3000, () => {
  console.log('Server started on port 3000');
});
